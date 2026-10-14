import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { connectDatabase } from '@codetogether/db';
import { ExecutionCoordinator } from '../src/execution-queue.js';
import { createApp } from '../src/app.js';
import { sourceHash } from '../src/executions.js';

// Requires the independent, healthy janitor from infra/compose.yaml. Never points at production.
test(
  'REAL execution stack: PostgreSQL outbox -> Redis -> separate worker -> isolated sandbox -> durable result',
  { skip: process.env.TEST_EXECUTION_STACK !== 'disposable-local', timeout: 60000 },
  async () => {
    assert.notEqual(process.env.NODE_ENV, 'production');
    assert.equal(process.env.DOCKER_HOST, undefined, 'local Docker socket only');
    assert.ok(process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL);
    for (const value of [process.env.TEST_DATABASE_URL, process.env.TEST_REDIS_URL])
      assert.ok(
        ['localhost', '127.0.0.1'].includes(new URL(value!).hostname),
        'disposable loopback services only',
      );
    const db = await connectDatabase(process.env.TEST_DATABASE_URL);
    await db.migrate();
    const token = randomUUID() + randomUUID();
    const coordinator = new ExecutionCoordinator(
      db.db,
      process.env.TEST_REDIS_URL!,
      async () => {},
    );
    const origin = 'http://localhost:3000';
    const app = createApp(db.db, { origin, executions: coordinator.service, workerToken: token });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const worker = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('../../execution-worker/src/main.ts', import.meta.url)),
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          REDIS_URL: process.env.TEST_REDIS_URL,
          EXECUTION_API_URL: `http://127.0.0.1:${address.port}`,
          EXECUTION_WORKER_TOKEN: token,
          SANDBOX_IMAGE: process.env.TEST_SANDBOX_IMAGE ?? 'codetogether-sandbox:local',
          SANDBOX_RUNTIME: process.env.TEST_SANDBOX_RUNTIME === 'runsc' ? 'runsc' : 'runc',
          SANDBOX_ALLOW_LOCAL_RUNC: 'true',
          DOCKER_SOCKET: process.env.TEST_DOCKER_SOCKET ?? '/var/run/docker.sock',
        },
        stdio: 'ignore',
      },
    );
    const headers = { Origin: origin, 'X-CodeTogether': '1' };
    const owner = request.agent(server);
    let roomId: string | undefined;
    try {
      const readyDeadline = Date.now() + 15000;
      while (!(await coordinator.service.health()).available && Date.now() < readyDeadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        (await coordinator.service.health()).available,
        true,
        'real worker + Docker + janitor ready',
      );
      coordinator.start();
      await owner
        .post('/api/auth/signup')
        .set(headers)
        .send({
          name: 'Real execution test',
          email: `${randomUUID()}@example.com`,
          password: 'disposable test password',
        })
        .expect(201);
      roomId = (
        await owner
          .post('/api/rooms')
          .set(headers)
          .send({ name: 'Disposable execution stack' })
          .expect(201)
      ).body.room.id;
      const file = (await owner.get(`/api/rooms/${roomId}`).expect(200)).body.files[0];
      const source =
        "process.stdout.write(require('fs').readFileSync(0,'utf8'));console.error('real sandbox')";
      const saved = (
        await owner
          .patch(`/api/files/${file.id}`)
          .set(headers)
          .send({ version: file.version, content: source })
          .expect(200)
      ).body.file;
      const path = `/api/rooms/${roomId}/executions`;
      const payload = {
        fileId: file.id,
        language: 'javascript',
        version: saved.version,
        sourceHash: sourceHash(source),
        stdin: 'real stdin',
        idempotencyKey: randomUUID(),
      };
      const first = (await owner.post(path).set(headers).send(payload).expect(202)).body.execution;
      const duplicate = (await owner.post(path).set(headers).send(payload).expect(202)).body
        .execution;
      assert.equal(first.id, duplicate.id);
      let execution = first;
      const deadline = Date.now() + 20000;
      while (['QUEUED', 'RUNNING'].includes(execution.status) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        execution = (await owner.get(`${path}/${first.id}`).expect(200)).body.execution;
      }
      assert.equal(execution.status, 'SUCCEEDED');
      const output = execution.chunks.map((c: { text: string }) => c.text).join('');
      assert.ok(output.includes('real stdin'));
      assert.ok(output.includes('real sandbox'));
      assert.equal(execution.sourceHash, payload.sourceHash);
      assert.ok(execution.attempt);
    } finally {
      if (roomId) await owner.delete(`/api/rooms/${roomId}`).set(headers);
      const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
      worker.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 6000))]);
      if (worker.exitCode === null) worker.kill('SIGKILL');
      await coordinator.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    }
  },
);
