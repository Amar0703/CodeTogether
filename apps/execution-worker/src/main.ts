import 'dotenv/config';
import Docker from 'dockerode';
import { z } from 'zod';
import {
  Worker,
  redisConnection,
  executionQueue,
  workerHeartbeatKey,
} from '@codetogether/execution';
import { workerClaimSchema, type WorkerClaim } from '@codetogether/contracts';
import { DockerSandbox } from './sandbox.js';

const env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    REDIS_URL: z.url(),
    EXECUTION_API_URL: z.url(),
    EXECUTION_WORKER_TOKEN: z.string().min(48),
    SANDBOX_IMAGE: z.string().regex(/^[a-zA-Z0-9./:@_-]+$/),
    SANDBOX_RUNTIME: z.enum(['runsc', 'runc']).default('runsc'),
    SANDBOX_ALLOW_LOCAL_RUNC: z.enum(['true', 'false']).default('false'),
    DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  })
  .parse(process.env);
if (
  env.SANDBOX_RUNTIME === 'runc' &&
  (env.NODE_ENV === 'production' || env.SANDBOX_ALLOW_LOCAL_RUNC !== 'true')
)
  throw new Error('Production requires runsc; local runc requires explicit opt-in');
if (
  env.NODE_ENV === 'production' &&
  (!env.EXECUTION_API_URL.startsWith('https://') ||
    !env.REDIS_URL.startsWith('rediss://') ||
    !env.SANDBOX_IMAGE.includes('@sha256:'))
)
  throw new Error('Production requires HTTPS API, TLS Redis and an immutable sandbox image digest');
const docker = new Docker({ socketPath: env.DOCKER_SOCKET, timeout: 5000 });
const sandbox = new DockerSandbox(docker, env.SANDBOX_IMAGE, env.SANDBOX_RUNTIME);
await sandbox.ready();
await sandbox.reap(true); // Exactly one worker per dedicated sandbox host.
const connection = redisConnection(env.REDIS_URL, true);
connection.on('error', () => {});
const control = redisConnection(env.REDIS_URL);
control.on('error', () => {});
const active = new Set<AbortController>();
let stopping = false;
let readyUntil = 0;
async function call<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(
    `${env.EXECUTION_API_URL.replace(/\/$/, '')}/api/internal/executions/${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CodeTogether': '1',
        Authorization: `Bearer ${env.EXECUTION_WORKER_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    },
  );
  if (!response.ok) throw new Error(`Worker protocol HTTP ${response.status}`);
  return (await response.json()) as T;
}
const worker = new Worker(
  executionQueue,
  async (job) => {
    if (stopping || Date.now() >= readyUntil)
      throw new Error('Execution infrastructure unavailable');
    const { executionId } = workerClaimSchema.parse(job.data);
    // Infrastructure failures before claiming may retry. A lost claim ack never starts a sandbox.
    const { claim } = await call<{ claim: WorkerClaim | null }>('claim', { executionId });
    if (!claim) return;
    const abort = new AbortController();
    active.add(abort);
    let renewing = false;
    const heartbeat = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try {
        const r = await call<{ active: boolean }>(`${executionId}/heartbeat`, {
          attempt: claim.attempt,
        });
        if (!r.active) abort.abort();
      } catch {
        abort.abort();
      } finally {
        renewing = false;
      }
    }, 1000);
    let lastOutput = 0;
    try {
      const result = await sandbox.run(claim, abort.signal, async (chunk) => {
        const delay = Math.max(0, lastOutput + 63 - Date.now());
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        abort.signal.throwIfAborted();
        const r = await call<{ active: boolean }>(`${executionId}/output`, {
          attempt: claim.attempt,
          chunk,
        });
        lastOutput = Date.now();
        if (!r.active) abort.abort();
      });
      // A failed/lost completion acknowledgment is reconciled; never rerun user code to repair it.
      await call(`${executionId}/finish`, { attempt: claim.attempt, result }).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      active.delete(abort);
    }
  },
  {
    connection,
    autorun: false,
    concurrency: 1,
    lockDuration: 30_000,
    maxStalledCount: 1,
    maxStartedAttempts: 2,
  },
);
worker.on('error', () => {});
worker.on('failed', (job) => console.warn('Execution delivery failed', { executionId: job?.id }));
let checking = false;
let started = false;
const readiness = setInterval(async () => {
  if (checking || stopping) return;
  checking = true;
  try {
    await sandbox.ready();
    await sandbox.reap();
    const watchdogs = await docker.listContainers({
      filters: JSON.stringify({ label: ['io.codetogether.watchdog=v1'] }),
    });
    const healthy = await Promise.all(watchdogs.map((w) => docker.getContainer(w.Id).inspect()));
    if (!healthy.some((w) => w.State.Health?.Status === 'healthy'))
      throw new Error('Healthy independent cleanup service required');
    await call('ready', {});
    readyUntil = Date.now() + 4000;
    await control.set(workerHeartbeatKey, 'ready', 'EX', 5);
    if (!started) {
      started = true;
      void worker.run().catch(() => console.warn('Execution consumer stopped'));
    }
  } catch {
    readyUntil = 0;
    for (const controller of active) controller.abort();
    await control.del(workerHeartbeatKey).catch(() => {});
  } finally {
    checking = false;
  }
}, 1500);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(readiness);
    for (const controller of active) controller.abort();
    void sandbox
      .close()
      .then(() => worker.close())
      .finally(() => {
        connection.disconnect();
        control.disconnect();
        process.exit(0);
      });
  });
console.log('Execution worker initialized; waiting for infrastructure readiness');
