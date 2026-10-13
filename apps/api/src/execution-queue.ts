import {
  Queue,
  executionQueue,
  redisConnection,
  workerHeartbeatKey,
} from '@codetogether/execution';
import { executions, type Database } from '@codetogether/db';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { ExecutionService } from './executions.js';
import type { ExecutionEvent } from '@codetogether/contracts';

export interface DispatchQueue {
  getJob(id: string): Promise<{ getState(): Promise<string> } | undefined>;
  add(name: string, data: { executionId: string }, options: { jobId: string; attempts: number; backoff: { type: string; delay: number }; removeOnComplete: { age: number; count: number }; removeOnFail: { age: number; count: number } }): Promise<unknown>;
}
export async function dispatchPending(db: Database, queue: DispatchQueue, service: ExecutionService) {
  const rows = await db.select({ id: executions.id }).from(executions).where(and(eq(executions.status, 'QUEUED'),
    or(isNull(executions.dispatchedAt), lt(executions.dispatchedAt, new Date(Date.now() - 10_000))))).limit(64);
  for (const { id } of rows) {
    const old = await queue.getJob(id);
    if (old && ['failed', 'completed'].includes(await old.getState())) {
      // Exhausted queue delivery never resets its retry budget by replacing the job.
      const [failed] = await db.update(executions).set({ status: 'FAILED', failure: 'INFRASTRUCTURE', finishedAt: new Date(), revision: 2 })
        .where(and(eq(executions.id, id), eq(executions.status, 'QUEUED'))).returning();
      if (failed) await service.publish(failed);
      continue;
    }
    await queue.add('execute', { executionId: id }, { jobId: id, attempts: 2, backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 86400, count: 1000 } });
    await db.update(executions).set({ dispatchedAt: new Date() }).where(and(eq(executions.id, id), eq(executions.status, 'QUEUED')));
  }
}

/** The QUEUED database row is the outbox. It is replayed until claimed, even after Redis data loss. */
export class ExecutionCoordinator {
  readonly connection;
  readonly queue;
  readonly service;
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(
    private db: Database,
    url: string,
    emit: (event: ExecutionEvent) => Promise<void>,
  ) {
    this.connection = redisConnection(url);
    this.connection.on('error', () => {});
    this.queue = new Queue(executionQueue, { connection: this.connection });
    this.queue.on('error', () => {});
    this.service = new ExecutionService(
      db,
      async () => {
        if (this.connection.status !== 'ready') return false;
        return !!(await this.connection.get(workerHeartbeatKey));
      },
      emit,
    );
  }
  start() {
    this.timer = setInterval(() => void this.tick(), 2000);
    this.timer.unref();
    void this.tick();
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.service.reconcile();
      if (this.connection.status !== 'ready') return;
      // One sandbox at a time globally; adding workers must not silently multiply this limit.
      await this.queue.setGlobalConcurrency(1);
      await dispatchPending(this.db, this.queue, this.service);
    } catch {
      // No source, connection URLs or provider errors in logs. Next tick repairs the outbox gap.
    } finally {
      this.busy = false;
    }
  }
  async close() {
    clearInterval(this.timer);
    await this.queue.close();
    this.connection.disconnect();
  }
}
