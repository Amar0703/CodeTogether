import { Redis } from 'ioredis';
export { Queue, Worker } from 'bullmq';
export const executionQueue = 'codetogether-execution-v1';
export const workerHeartbeatKey = 'ct-execution-worker-v1';
export function redisConnection(url: string, worker = false) {
  return new Redis(url, {
    maxRetriesPerRequest: worker ? null : 1,
    enableOfflineQueue: worker,
    ...(worker ? {} : { commandTimeout: 2000 }),
    connectTimeout: 2000,
    retryStrategy: (times) => Math.min(times * 250, 5000),
  });
}
