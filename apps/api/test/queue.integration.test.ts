import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Queue, Worker, redisConnection } from '@codetogether/execution';

test(
  'REAL Redis/BullMQ delivery, idempotent job IDs, bounded retries and reconnect',
  { skip: !process.env.TEST_REDIS_URL, timeout: 30000 },
  async () => {
    if (process.env.NODE_ENV === 'production')
      throw new Error('Never use production Redis for tests');
    const name = `ct-test-${randomUUID()}`,
      connection = redisConnection(process.env.TEST_REDIS_URL!, true);
    connection.on('error', () => {});
    const queue = new Queue(name, { connection });
    const starts: string[] = [];
    const worker = new Worker(
      name,
      async (job) => {
        starts.push(job.id!);
        if (job.name === 'infra') throw new Error('Simulated pre-claim infrastructure failure');
        return 'done';
      },
      { connection, concurrency: 1, maxStalledCount: 1 },
    );
    worker.on('error', () => {});
    try {
      await queue.waitUntilReady();
      await worker.waitUntilReady();
      await queue.setGlobalConcurrency(1);
      const id = randomUUID();
      await queue.add('success', { executionId: id }, { jobId: id });
      await queue.add('success', { executionId: id }, { jobId: id });
      const failedId = randomUUID();
      await queue.add(
        'infra',
        {},
        { jobId: failedId, attempts: 2, backoff: { type: 'fixed', delay: 50 } },
      );
      const end = Date.now() + 10000;
      while ((await queue.getJob(failedId))?.attemptsMade !== 2 && Date.now() < end)
        await new Promise((r) => setTimeout(r, 50));
      assert.equal(starts.filter((s) => s === id).length, 1);
      assert.equal(starts.filter((s) => s === failedId).length, 2);
      assert.equal(await (await queue.getJob(failedId))?.getState(), 'failed');
      const reader = redisConnection(process.env.TEST_REDIS_URL!);
      reader.on('error', () => {});
      const reopened = new Queue(name, { connection: reader });
      await reopened.waitUntilReady();
      assert.equal(await (await reopened.getJob(id))?.getState(), 'completed');
      await reopened.close();
      reader.disconnect();
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      connection.disconnect();
    }
  },
);
