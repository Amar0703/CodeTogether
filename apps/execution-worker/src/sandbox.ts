import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import type { Socket } from 'node:net';
import {
  executionLimits as L,
  executionResultSchema,
  type ExecutionResult,
  type WorkerClaim,
  type OutputChunk,
} from '@codetogether/contracts';

export const sandboxLabel = 'io.codetogether.sandbox';
export function containerOptions(
  image: string,
  runtime: 'runsc' | 'runc',
  id: string,
): Docker.ContainerCreateOptions {
  return {
    Image: image,
    name: `ct-execution-${id}`,
    User: '65534:65534',
    WorkingDir: '/work',
    Entrypoint: ['/usr/bin/python3', '-I', '/opt/runner.py'],
    Cmd: [],
    Env: [
      'PATH=/usr/local/bin:/usr/bin:/bin',
      'HOME=/work',
      'LANG=C.UTF-8',
      'PYTHONDONTWRITEBYTECODE=1',
    ],
    OpenStdin: true,
    StdinOnce: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Labels: { [sandboxLabel]: 'v1', 'io.codetogether.deadline': String(Date.now() + L.sandboxMs) },
    NetworkDisabled: true,
    HostConfig: {
      Runtime: runtime,
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: L.memoryBytes,
      MemorySwap: L.memoryBytes,
      NanoCpus: 1_000_000_000,
      PidsLimit: L.processes,
      OomKillDisable: false,
      Init: true,
      Tmpfs: {
        '/work': 'rw,nosuid,nodev,size=32m,mode=1777',
        '/tmp': 'rw,noexec,nosuid,nodev,size=8m,mode=1777',
      },
      ShmSize: 4 * 1024 * 1024,
      Ulimits: [
        { Name: 'nofile', Soft: 64, Hard: 64 },
        { Name: 'fsize', Soft: 16 * 1024 * 1024, Hard: 16 * 1024 * 1024 },
        { Name: 'core', Soft: 0, Hard: 0 },
      ],
      LogConfig: { Type: 'none', Config: {} },
      RestartPolicy: { Name: 'no' },
      // No bind mounts, host namespaces, devices, ports or infrastructure environment.
    },
  };
}
export class DockerSandbox {
  private containers = new Set<Docker.Container>();
  constructor(
    readonly docker: Docker,
    readonly image: string,
    readonly runtime: 'runsc' | 'runc',
  ) {}
  async ready() {
    const info = await this.docker.info();
    if (
      info.OSType !== 'linux' ||
      !info.MemoryLimit ||
      !info.SwapLimit ||
      !info.CpuCfsQuota ||
      !info.PidsLimit ||
      !info.Runtimes?.[this.runtime]
    )
      throw new Error('Sandbox runtime or required cgroup controls unavailable');
    const image = await this.docker.getImage(this.image).inspect();
    if (image.Config.Volumes && Object.keys(image.Config.Volumes).length)
      throw new Error('Sandbox image must not declare volumes');
  }
  async reap(all = false) {
    for (const info of await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${sandboxLabel}=v1`] }),
    })) {
      if (all || Number(info.Labels['io.codetogether.deadline'] ?? 0) < Date.now())
        await this.docker
          .getContainer(info.Id)
          .remove({ force: true, v: true })
          .catch((error: unknown) => {
            if ((error as { statusCode?: number }).statusCode !== 404) throw error;
          });
    }
  }
  async close() {
    await Promise.all(
      [...this.containers].map((c) => c.remove({ force: true, v: true }).catch(() => {})),
    );
  }
  async run(
    claim: WorkerClaim,
    signal: AbortSignal,
    output: (chunk: OutputChunk) => Promise<void>,
  ): Promise<ExecutionResult> {
    const started = Date.now();
    let container: Docker.Container | undefined;
    let timer: NodeJS.Timeout | undefined;
    let phaseTimer: NodeJS.Timeout | undefined;
    let result: ExecutionResult | undefined;
    let bytes = 0,
      sequence = 0,
      protocolBytes = 0;
    let truncated = false,
      timedOut = false;
    const remove = async () => {
      if (container) await container.remove({ force: true, v: true }).catch(() => {});
    };
    const aborted = () => {
      void remove();
    };
    try {
      signal.throwIfAborted();
      container = await this.docker.createContainer(
        containerOptions(this.image, this.runtime, claim.attempt),
      );
      this.containers.add(container);
      signal.addEventListener('abort', aborted, { once: true });
      signal.throwIfAborted();
      timer = setTimeout(() => {
        timedOut = true;
        void remove();
      }, L.sandboxMs);
      const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      });
      // The hijacked Docker stream is a socket. Independent phase timers govern it;
      // the short HTTP control timeout must not terminate a quiet C++ compilation.
      (stream as Socket).setTimeout(0);
      let ended = false;
      const drained = new Promise<void>((resolve) => {
        const done = () => {
          ended = true;
          resolve();
        };
        stream.once('end', done);
        stream.once('close', done);
      });
      const stdout = new PassThrough({ highWaterMark: 8192 }),
        stderr = new PassThrough({ highWaterMark: 4096 });
      this.docker.modem.demuxStream(stream, stdout, stderr);
      stderr.on('data', () => {}); // Runner diagnostics are not program output and may not be logged.
      let buffer = '';
      let pending = Promise.resolve();
      let protocolError = false;
      let runPhase = claim.language !== 'cpp';
      stdout.on('data', (data: Buffer) => {
        protocolBytes += data.length;
        if (protocolBytes > 600_000) {
          protocolError = true;
          void remove();
          return;
        }
        buffer += data.toString('utf8');
        if (buffer.length > 100_000) {
          protocolError = true;
          void remove();
          return;
        }
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const packet = JSON.parse(line);
            if (packet.kind === 'phase' && packet.phase === 'run') {
              // Exactly one compile -> run transition. User output cannot extend this clock.
              if (!runPhase) {
                runPhase = true;
                clearTimeout(phaseTimer);
                phaseTimer = setTimeout(() => {
                  timedOut = true;
                  void remove();
                }, L.runMs);
              }
              continue;
            }
            if (packet.kind === 'result') {
              result = executionResultSchema.parse(packet.result);
              continue;
            }
            if (
              packet.kind !== 'output' ||
              !['stdout', 'stderr'].includes(packet.stream) ||
              typeof packet.text !== 'string'
            )
              throw new Error('Protocol');
            // JSON ASCII encoding from runner avoids UTF-8 split ambiguity across transport frames.
            for (let text of splitOutput(packet.text.replaceAll('\0', '\uFFFD'))) {
              if (sequence >= L.chunks || bytes >= L.outputBytes) {
                truncated = true;
                void remove();
                break;
              }
              if (Buffer.byteLength(text) > L.outputBytes - bytes) truncated = true;
              text = fitBytes(text, L.outputBytes - bytes);
              bytes += Buffer.byteLength(text);
              const chunk: OutputChunk = { stream: packet.stream, text, sequence: ++sequence };
              // Bounded by 64 KiB/256 chunks. Delivery is rate limited by the worker.
              pending = pending.then(async () => {
                signal.throwIfAborted();
                await output(chunk);
              });
              pending.catch(() => {
                protocolError = true;
                void remove();
              });
            }
          } catch {
            protocolError = true;
            void remove();
          }
        }
      });
      await container.start();
      phaseTimer = setTimeout(
        () => {
          timedOut = true;
          void remove();
        },
        runPhase ? L.runMs : L.compileMs,
      );
      stream.end(
        JSON.stringify({ language: claim.language, source: claim.source, stdin: claim.stdin }) +
          '\n',
      );
      let state = (await container.inspect()).State;
      while (state.Running) {
        signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 100));
        state = (await container.inspect()).State;
      }
      clearTimeout(phaseTimer);
      clearTimeout(timer);
      // Docker attach EOF can trail wait(). Drain before accepting final status.
      if (!ended)
        await Promise.race([
          drained,
          new Promise<void>((resolve) => setTimeout(resolve, 1000).unref()),
        ]);
      await pending;
      if (protocolError || !result) {
        const info = await container.inspect();
        return {
          status: 'FAILED',
          failure: info.State.OOMKilled ? 'RESOURCE_LIMIT' : 'INFRASTRUCTURE',
          durationMs: Math.min(Date.now() - started, 60000),
          exitCode: null,
          truncated,
        };
      }
      return { ...result, truncated: result.truncated || truncated };
    } catch {
      return {
        status: signal.aborted ? 'CANCELLED' : timedOut ? 'TIMED_OUT' : 'FAILED',
        failure: signal.aborted
          ? 'USER_CANCELLED'
          : timedOut || truncated
            ? 'RESOURCE_LIMIT'
            : 'INFRASTRUCTURE',
        exitCode: null,
        durationMs: Math.min(Date.now() - started, 60000),
        truncated,
      };
    } finally {
      clearTimeout(timer);
      clearTimeout(phaseTimer);
      signal.removeEventListener('abort', aborted);
      await remove();
      if (container) this.containers.delete(container);
    }
  }
}
export function fitBytes(text: string, budget: number) {
  const bytes = Buffer.from(text);
  if (bytes.length <= budget) return text;
  let end = budget;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
export function splitOutput(text: string) {
  const chunks: string[] = [];
  while (text) {
    const part = fitBytes(text, L.chunkBytes);
    chunks.push(part);
    text = text.slice(part.length);
  }
  return chunks;
}
