import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import * as Y from 'yjs';
import { DocumentStore } from '../src/documents.js';
import { createServer } from 'node:http';
import { io } from 'socket.io-client';
import { Realtime } from '../src/realtime.js';
import { connectDatabase, executions, files, sessions } from '@codetogether/db';
import {
  executionSubmitSchema,
  executionLimits as L,
  type ExecutionEvent,
} from '@codetogether/contracts';
import { ExecutionService, sourceHash } from '../src/executions.js';
import { createApp } from '../src/app.js';
import { hashToken } from '../src/security.js';
import { dispatchPending, type DispatchQueue } from '../src/execution-queue.js';

const origin = 'http://localhost:3000',
  headers = { 'X-CodeTogether': '1', Origin: origin };
let db: Awaited<ReturnType<typeof connectDatabase>>,
  service: ExecutionService,
  app: ReturnType<typeof createApp>;
const events: ExecutionEvent[] = [];
let healthy = true;
before(async () => {
  db = await connectDatabase(process.env.TEST_DATABASE_URL);
  await db.migrate();
  service = new ExecutionService(
    db.db,
    async () => healthy,
    async (event) => {
      events.push(event);
    },
  );
  app = createApp(db.db, {
    origin,
    rateLimit: 1000,
    executions: service,
    workerToken: 'x'.repeat(64),
  });
});
after(async () => {
  await db?.close();
});
async function fixture() {
  const owner = request.agent(app),
    editor = request.agent(app),
    viewer = request.agent(app),
    outsider = request.agent(app);
  const identities: Record<string, string> = {},
    hashes: Record<string, string> = {};
  for (const [name, agent] of Object.entries({ owner, editor, viewer, outsider })) {
    const r = await agent
      .post('/api/auth/signup')
      .set(headers)
      .send({
        name: `Execution ${name}`,
        email: `${randomUUID()}@example.com`,
        password: 'execution password',
      })
      .expect(201);
    identities[name] = r.body.user.id;
    hashes[name] = hashToken(r.headers['set-cookie'][0].split(';')[0].split('=')[1]);
  }
  const roomId = (
    await owner.post('/api/rooms').set(headers).send({ name: 'Execution test' }).expect(201)
  ).body.room.id;
  for (const [agent, role] of [
    [editor, 'EDITOR'],
    [viewer, 'VIEWER'],
  ] as const) {
    const r = await owner
      .post(`/api/rooms/${roomId}/invites`)
      .set(headers)
      .send({ role })
      .expect(201);
    await agent
      .post(`/api/invites/${r.body.url.split('/').pop()}/join`)
      .set(headers)
      .expect(200);
  }
  const file = (await owner.get(`/api/rooms/${roomId}`).expect(200)).body.files[0];
  const path = `/api/rooms/${roomId}/executions`;
  const input = {
    fileId: file.id,
    idempotencyKey: randomUUID(),
    language: 'javascript',
    sourceHash: sourceHash(file.content),
    version: file.version,
    stdin: '',
  };
  return { owner, editor, viewer, outsider, roomId, file, path, input, identities, hashes };
}
async function submit(f: Awaited<ReturnType<typeof fixture>>, agent = f.owner) {
  return (
    await agent
      .post(f.path)
      .set(headers)
      .send({ ...f.input, idempotencyKey: randomUUID() })
      .expect(202)
  ).body.execution;
}
const success = {
  status: 'SUCCEEDED' as const,
  failure: null,
  exitCode: 0,
  durationMs: 10,
  truncated: false,
};
test('execution authentication, CSRF, strict identity and file/room/role isolation', async () => {
  const f = await fixture();
  await request(app).get(f.path).expect(401);
  await f.owner.post(f.path).send(f.input).expect(403);
  await f.owner
    .post(f.path)
    .set({ ...headers, Origin: 'https://evil.example' })
    .send(f.input)
    .expect(403);
  await f.viewer.post(f.path).set(headers).send(f.input).expect(403);
  await f.outsider.post(f.path).set(headers).send(f.input).expect(404);
  await f.owner
    .post(f.path)
    .set(headers)
    .send({ ...f.input, userId: f.identities.editor })
    .expect(400);
  await f.owner
    .post(f.path)
    .set(headers)
    .send({ ...f.input, fileId: randomUUID() })
    .expect(404);
  const other = await fixture();
  await f.owner
    .post(f.path)
    .set(headers)
    .send({ ...f.input, fileId: other.file.id })
    .expect(404);
  const run = await submit(f);
  await f.viewer.get(`${f.path}/${run.id}`).expect(200);
  await f.outsider.get(`${f.path}/${run.id}`).expect(404);
  await other.owner.get(`${other.path}/${run.id}`).expect(404);
  await f.viewer.post(`${f.path}/${run.id}/cancel`).set(headers).expect(403);
  await f.editor.post(`${f.path}/${run.id}/cancel`).set(headers).expect(403);
  await f.owner.post(`${f.path}/${run.id}/cancel`).set(headers).expect(200);
  await request(app)
    .post('/api/internal/executions/claim')
    .set(headers)
    .send({ executionId: run.id })
    .expect(401);
});
test('immutable snapshots reject save/version races and unsupported or mismatched languages', async () => {
  const f = await fixture();
  await f.owner
    .post(f.path)
    .set(headers)
    .send({ ...f.input, version: f.input.version + 1 })
    .expect(409);
  await f.owner
    .post(f.path)
    .set(headers)
    .send({ ...f.input, sourceHash: sourceHash('new offline draft') })
    .expect(409);
  await f.owner
    .post(f.path)
    .set(headers)
    .send({ ...f.input, language: 'python' })
    .expect(400);
  const run = await submit(f);
  await db.db
    .update(files)
    .set({ content: 'new edits', version: 100 })
    .where(eq(files.id, f.file.id));
  const claim = await service.claim(run.id);
  assert.ok(claim);
  assert.equal(claim.source, f.file.content);
  const view = (await f.viewer.get(`${f.path}/${run.id}`)).body.execution;
  assert.equal(view.sourceHash, f.input.sourceHash);
  assert.equal(view.source, undefined);
  assert.equal(view.sessionHash, undefined);
  await service.update(run.id, claim.attempt, undefined, success);
  assert.equal(
    executionSubmitSchema.safeParse({ ...f.input, stdin: '😀'.repeat(8192) }).success,
    false,
  );
  assert.equal(executionSubmitSchema.safeParse({ ...f.input, stdin: '\0' }).success, false);
});
test('concurrent idempotency and active admission are durable across service restart', async () => {
  const f = await fixture();
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => f.owner.post(f.path).set(headers).send(f.input)),
  );
  assert.ok(responses.every((r) => r.status === 202));
  assert.equal(new Set(responses.map((r) => r.body.execution.id)).size, 1);
  await f.owner
    .post(f.path)
    .set(headers)
    .send({ ...f.input, stdin: 'different' })
    .expect(409);
  const more = await Promise.all(
    Array.from({ length: 3 }, () =>
      f.owner
        .post(f.path)
        .set(headers)
        .send({ ...f.input, idempotencyKey: randomUUID() }),
    ),
  );
  assert.equal(more.filter((r) => r.status === 202).length, 1);
  assert.equal(more.filter((r) => r.status === 429).length, 2);
  const restarted = new ExecutionService(db.db, async () => true);
  await assert.rejects(
    restarted.submit(f.roomId, { id: f.identities.owner, name: 'Owner' }, f.hashes.owner, {
      ...f.input,
      idempotencyKey: randomUUID(),
    }),
    /capacity/,
  );
  await f.owner.post(`${f.path}/${responses[0].body.execution.id}/cancel`).set(headers).expect(200);
  await f.owner
    .post(`${f.path}/${more.find((r) => r.status === 202)!.body.execution.id}/cancel`)
    .set(headers)
    .expect(200);
});
test('duplicate claims, stale attempts, ordered output and cancel/completion races are fenced', async () => {
  const f = await fixture(),
    r = await submit(f);
  const claims = await Promise.all([service.claim(r.id), service.claim(r.id)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const c = claims.find(Boolean)!;
  await assert.rejects(service.update(r.id, randomUUID(), undefined, success), /lease/);
  const chunk = { sequence: 1, stream: 'stdout' as const, text: '<script>alert(1)</script>\n' };
  await service.update(r.id, c.attempt, chunk);
  await service.update(r.id, c.attempt, chunk);
  await assert.rejects(
    service.update(r.id, c.attempt, { ...chunk, text: 'conflict' }),
    /Conflicting/,
  );
  await assert.rejects(service.update(r.id, c.attempt, { ...chunk, sequence: 3 }), /order/);
  const outcomes = await Promise.allSettled([
    service.cancel(f.roomId, r.id, f.identities.owner),
    service.update(r.id, c.attempt, undefined, success),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  const final = await service.get(f.roomId, r.id, f.identities.viewer);
  assert.ok(['SUCCEEDED', 'CANCELLED'].includes(final.status));
  assert.equal(final.chunks.length, 1);
  const cancelled = await service.cancel(f.roomId, r.id, f.identities.owner);
  assert.equal(cancelled.status, final.status);
  assert.equal(await service.claim(r.id), null);
  await assert.rejects(service.update(r.id, c.attempt, undefined, success), /lease/);
});
test('queue expiry and abandoned leases reconcile without rerunning possibly executed source', async () => {
  const f = await fixture(),
    r = await submit(f);
  await db.db
    .update(executions)
    .set({ createdAt: new Date(Date.now() - L.queueWaitMs - 1) })
    .where(eq(executions.id, r.id));
  await service.reconcile();
  assert.equal((await service.get(f.roomId, r.id, f.identities.owner)).failure, 'QUEUE_EXPIRED');
  const second = await submit(f),
    c = await service.claim(second.id);
  assert.ok(c);
  await db.db
    .update(executions)
    .set({ leaseUntil: new Date(0) })
    .where(eq(executions.id, second.id));
  await service.reconcile();
  assert.equal(
    (await service.get(f.roomId, second.id, f.identities.owner)).failure,
    'INFRASTRUCTURE',
  );
  assert.equal(await service.claim(second.id), null);
  await assert.rejects(service.update(second.id, c.attempt, undefined, success), /lease/);
});
test('demotion is sticky, removal/logout/expiry and file/room deletion cancel work', async () => {
  for (const action of ['demotion', 'removal', 'logout', 'expiry', 'file', 'room']) {
    const f = await fixture(),
      r = await submit(f, f.editor),
      c = await service.claim(r.id);
    assert.ok(c);
    if (action === 'demotion') {
      await f.owner
        .patch(`/api/rooms/${f.roomId}/members/${f.identities.editor}`)
        .set(headers)
        .send({ role: 'VIEWER' })
        .expect(204);
      await f.owner
        .patch(`/api/rooms/${f.roomId}/members/${f.identities.editor}`)
        .set(headers)
        .send({ role: 'EDITOR' })
        .expect(204);
    } else if (action === 'removal')
      await f.owner
        .delete(`/api/rooms/${f.roomId}/members/${f.identities.editor}`)
        .set(headers)
        .expect(204);
    else if (action === 'logout') await f.editor.post('/api/auth/logout').set(headers).expect(204);
    else if (action === 'expiry')
      await db.db
        .update(sessions)
        .set({ expiresAt: new Date(0) })
        .where(eq(sessions.tokenHash, f.hashes.editor));
    else if (action === 'file')
      await f.owner.delete(`/api/files/${f.file.id}`).set(headers).expect(204);
    else await f.owner.delete(`/api/rooms/${f.roomId}`).set(headers).expect(204);
    await service.reconcile();
    if (action === 'room') await f.owner.get(`${f.path}/${r.id}`).expect(404);
    else
      assert.equal(
        (await service.get(f.roomId, r.id, f.identities.owner)).status,
        'CANCELLED',
        action,
      );
    await assert.rejects(service.update(r.id, c.attempt, undefined, success));
  }
});
test('bounded output, pagination, availability failures and no sensitive socket payloads', async () => {
  const f = await fixture(),
    r = await submit(f),
    c = await service.claim(r.id);
  assert.ok(c);
  for (let n = 1; n <= 16; n++)
    await service.update(r.id, c.attempt, {
      sequence: n,
      stream: n % 2 ? 'stdout' : 'stderr',
      text: 'x'.repeat(4096),
    });
  await assert.rejects(
    service.update(r.id, c.attempt, { sequence: 17, stream: 'stdout', text: 'x' }),
    /limit/,
  );
  await service.update(r.id, c.attempt, undefined, { ...success, truncated: true });
  const second = await submit(f);
  await service.cancel(f.roomId, second.id, f.identities.owner);
  const page = (await f.viewer.get(`${f.path}?limit=1`).expect(200)).body;
  assert.equal(page.executions.length, 1);
  assert.ok(page.nextCursor);
  assert.equal(
    (await f.viewer.get(`${f.path}?limit=1&before=${page.nextCursor}`)).body.executions[0].id,
    r.id,
  );
  await f.viewer.get(`${f.path}?limit=100`).expect(400);
  assert.equal(JSON.stringify(events).includes('sessionHash'), false);
  healthy = false;
  try {
    await f.owner
      .post(f.path)
      .set(headers)
      .send({ ...f.input, idempotencyKey: randomUUID() })
      .expect(503);
    await f.owner.get('/api/health').expect(200);
    await f.owner.get(`/api/rooms/${f.roomId}`).expect(200);
    await f.viewer.get(`${f.path}/${r.id}`).expect(200);
  } finally {
    healthy = true;
  }
  const [stored] = await db.db
    .select()
    .from(executions)
    .where(and(eq(executions.id, r.id), eq(executions.roomId, f.roomId)));
  assert.equal(stored.outputBytes, 65536);
});
test('outbox repairs enqueue/ack loss and Redis data loss; exhausted deliveries stay terminal', async () => {
  const f = await fixture(),
    r = await submit(f);
  const jobs = new Map<string, string>();
  let fail = true,
    calls = 0;
  const queue: DispatchQueue = {
    async getJob(id) {
      return jobs.has(id)
        ? {
            async getState() {
              return jobs.get(id)!;
            },
          }
        : undefined;
    },
    async add(_name, data, options) {
      calls++;
      assert.equal(options.attempts, 2);
      jobs.set(data.executionId, 'waiting'); // Simulate Redis commit followed by lost acknowledgment.
      if (fail) throw new Error('lost Redis acknowledgment');
    },
  };
  await assert.rejects(dispatchPending(db.db, queue, service), /acknowledgment/);
  const [pending] = await db.db.select().from(executions).where(eq(executions.id, r.id));
  assert.equal(pending.dispatchedAt, null);
  assert.equal(pending.status, 'QUEUED');
  fail = false;
  await dispatchPending(db.db, queue, service);
  assert.equal(jobs.size, 1);
  jobs.clear();
  await db.db
    .update(executions)
    .set({ dispatchedAt: new Date(0) })
    .where(eq(executions.id, r.id));
  await dispatchPending(db.db, queue, service);
  assert.equal(jobs.size, 1);
  assert.ok(calls >= 3);
  jobs.set(r.id, 'failed');
  await db.db
    .update(executions)
    .set({ dispatchedAt: new Date(0) })
    .where(eq(executions.id, r.id));
  await dispatchPending(db.db, queue, service);
  assert.equal((await service.get(f.roomId, r.id, f.identities.owner)).failure, 'INFRASTRUCTURE');
  assert.equal(await service.claim(r.id), null);
});
test('acknowledged Yjs projection is required; older visible hashes never execute newer text', async () => {
  const f = await fixture();
  const documents = new DocumentStore(db.db);
  const initial = await documents.sync(f.roomId, f.file.id, {}, async () => 'OWNER');
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(initial.update, 'base64'));
  const text = doc.getText('content');
  text.delete(0, text.length);
  text.insert(0, 'console.log("acknowledged")');
  const ack = await documents.sync(
    f.roomId,
    f.file.id,
    { update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') },
    async () => 'OWNER',
  );
  await f.owner.post(f.path).set(headers).send(f.input).expect(409);
  const accepted = await f.owner
    .post(f.path)
    .set(headers)
    .send({ ...f.input, sourceHash: sourceHash(text.toString()), version: ack.version })
    .expect(202);
  const claim = await service.claim(accepted.body.execution.id);
  assert.ok(claim);
  assert.equal(claim.source, text.toString());
  await service.update(claim.executionId, claim.attempt, undefined, success);
  doc.destroy();
});
test('room and global admission ceilings and rolling submission rate survive completed runs', async () => {
  const f = await fixture();
  const runs = [
    await submit(f),
    await submit(f),
    await submit(f, f.editor),
    await submit(f, f.editor),
  ];
  await f.owner
    .patch(`/api/rooms/${f.roomId}/members/${f.identities.viewer}`)
    .set(headers)
    .send({ role: 'EDITOR' })
    .expect(204);
  await f.viewer
    .post(f.path)
    .set(headers)
    .send({ ...f.input, idempotencyKey: randomUUID() })
    .expect(429);
  for (const r of runs) await service.cancel(f.roomId, r.id, f.identities.owner);
  for (let n = 0; n < 8; n++) {
    const r = await submit(f);
    await service.cancel(f.roomId, r.id, f.identities.owner);
  }
  await f.owner
    .post(f.path)
    .set(headers)
    .send({ ...f.input, idempotencyKey: randomUUID() })
    .expect(429);
  const fresh = await fixture();
  const r = await submit(fresh);
  const [row] = await db.db.select().from(executions).where(eq(executions.id, r.id));
  const ids = Array.from({ length: 63 }, () => randomUUID());
  await db.db
    .insert(executions)
    .values(ids.map((id) => ({ ...row, id, sequence: undefined, idempotencyKey: randomUUID() })));
  try {
    await fresh.editor
      .post(fresh.path)
      .set(headers)
      .send({ ...fresh.input, idempotencyKey: randomUUID() })
      .expect(429);
  } finally {
    await db.db.delete(executions).where(inArray(executions.id, ids));
    await service.cancel(fresh.roomId, r.id, fresh.identities.owner);
  }
});
test('worker HTTP protocol validates attempts and payloads; socket output stops after access removal', async () => {
  const f = await fixture(),
    realtime = new Realtime(db.db, origin);
  const emitting = new ExecutionService(
    db.db,
    async () => true,
    (e) => realtime.publishExecution(e),
  );
  const server = createServer(
    createApp(db.db, { origin, realtime, executions: emitting, workerToken: 'x'.repeat(64) }),
  );
  realtime.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const socket = io(`http://127.0.0.1:${address.port}`, {
    transports: ['websocket'],
    auth: { ticket: (await realtime.ticket(f.hashes.viewer)).ticket },
    extraHeaders: { Origin: origin },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    await socket.timeout(2000).emitWithAck('room:join', { roomId: f.roomId });
    const received: ExecutionEvent[] = [];
    socket.on('execution:event', (e) => received.push(e));
    const r = await emitting.submit(
      f.roomId,
      { id: f.identities.owner, name: 'Owner' },
      f.hashes.owner,
      f.input,
    );
    const auth = { ...headers, Authorization: `Bearer ${'x'.repeat(64)}` };
    const client = request(server);
    await client
      .post('/api/internal/executions/claim')
      .set(auth)
      .send({ executionId: r.id, userId: f.identities.owner })
      .expect(400);
    const c = (
      await client
        .post('/api/internal/executions/claim')
        .set(auth)
        .send({ executionId: r.id })
        .expect(200)
    ).body.claim;
    await client
      .post(`/api/internal/executions/${r.id}/output`)
      .set(auth)
      .send({ attempt: c.attempt, chunk: { sequence: 1, stream: 'stdout', text: 'first' } })
      .expect(200);
    const deadline = Date.now() + 2000;
    while (!received.some((e) => e.chunk?.text === 'first') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(received.some((e) => e.chunk?.text === 'first'));
    await f.owner
      .delete(`/api/rooms/${f.roomId}/members/${f.identities.viewer}`)
      .set(headers)
      .expect(204);
    const count = received.length;
    await client
      .post(`/api/internal/executions/${r.id}/output`)
      .set(auth)
      .send({
        attempt: c.attempt,
        chunk: { sequence: 2, stream: 'stdout', text: 'secret after removal' },
      })
      .expect(200);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, count);
    await client
      .post(`/api/internal/executions/${r.id}/finish`)
      .set(auth)
      .send({ attempt: c.attempt, result: success })
      .expect(200);
    await client
      .post(`/api/internal/executions/${r.id}/finish`)
      .set(auth)
      .send({ attempt: randomUUID(), result: success })
      .expect(409);
    const metrics = await client.get('/api/internal/executions/metrics').set(auth).expect(200);
    assert.equal(metrics.body.retentionDays, 7);
  } finally {
    socket.disconnect();
    await realtime.close();
  }
});
