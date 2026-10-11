import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import * as Y from 'yjs';
import { eq, sql } from 'drizzle-orm';
import { connectDatabase, documents } from '@codetogether/db';
import type {
  ClientEvents,
  ServerEvents,
  RealtimeResult,
  DocumentSync,
  DocumentPeer,
} from '@codetogether/contracts';
import { createApp } from '../src/app.js';
import { Realtime } from '../src/realtime.js';

const origin = 'http://localhost:3000';
const headers = { Origin: origin, 'X-CodeTogether': '1' };
type Client = Socket<ServerEvents, ClientEvents>;
let connection: Awaited<ReturnType<typeof connectDatabase>>;
let realtime: Realtime, app: ReturnType<typeof createApp>, url: string;
let gateway: ReturnType<Realtime['attach']>;
let owner: ReturnType<typeof request.agent>,
  editor: ReturnType<typeof request.agent>,
  outsider: ReturnType<typeof request.agent>;
const cookies = new Map<string, string>();
let roomId: string, fileId: string, editorId: string, a: Client, b: Client;
const clients: Client[] = [];
const enc = (value: Uint8Array) => Buffer.from(value).toString('base64');
const dec = (value: string) => Buffer.from(value, 'base64');
function ok<T>(result: RealtimeResult<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
function code(result: RealtimeResult<unknown>, expected: string) {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, expected);
}
async function start() {
  realtime = new Realtime(connection.db, origin);
  app = createApp(connection.db, { origin, realtime, rateLimit: 1000 });
  const server = createServer(app);
  gateway = realtime.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  url = `http://127.0.0.1:${address.port}`;
}
async function connect(agent = owner) {
  const ticket = (await agent.post('/api/realtime/ticket').set(headers).expect(200)).body.ticket;
  const socket: Client = io(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { ticket },
    extraHeaders: { Origin: origin },
  });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}
const join = (
  s: Client,
  doc: Y.Doc,
  id = fileId,
  room = roomId,
): Promise<RealtimeResult<DocumentSync>> =>
  s.timeout(4000).emitWithAck('doc:join', {
    roomId: room,
    fileId: id,
    clientId: doc.clientID,
    vector: enc(Y.encodeStateVector(doc)),
  });
const write = (
  s: Client,
  doc: Y.Doc,
  vector: Uint8Array = new Uint8Array([0]),
  id = fileId,
): Promise<RealtimeResult<DocumentSync>> =>
  s.timeout(4000).emitWithAck('doc:update', {
    roomId,
    fileId: id,
    update: enc(Y.encodeStateAsUpdate(doc, vector)),
    vector: enc(Y.encodeStateVector(doc)),
  });
before(async () => {
  connection = await connectDatabase(process.env.TEST_DATABASE_URL);
  await connection.migrate();
  await start();
  owner = request.agent(app);
  editor = request.agent(app);
  outsider = request.agent(app);
  for (const [agent, name] of [
    [owner, 'Doc owner'],
    [editor, 'Doc editor'],
    [outsider, 'Outsider'],
  ] as const) {
    const result = await agent
      .post('/api/auth/signup')
      .set(headers)
      .send({ name, email: `${randomUUID()}@example.com`, password: 'correct horse battery' })
      .expect(201);
    cookies.set(name, result.headers['set-cookie'][0].split(';')[0]);
    if (agent === editor) editorId = result.body.user.id;
  }
  roomId = (
    await owner.post('/api/rooms').set(headers).send({ name: 'Collaborative tests' }).expect(201)
  ).body.room.id;
  fileId = (await owner.get(`/api/rooms/${roomId}`)).body.files[0].id;
  await owner
    .patch(`/api/files/${fileId}`)
    .set(headers)
    .send({ content: 'existing content', version: 1 })
    .expect(200);
  const invite = (
    await owner.post(`/api/rooms/${roomId}/invites`).set(headers).send({ role: 'EDITOR' })
  ).body.url
    .split('/')
    .at(-1);
  await editor.post(`/api/invites/${invite}/join`).set(headers).expect(200);
  a = await connect();
  b = await connect(editor);
});
after(async () => {
  clients.forEach((s) => s.disconnect());
  await realtime?.close();
  await connection?.close();
});

test('document actions require a ticket-authenticated room subscription and reject room/file isolation violations', async () => {
  const doc = new Y.Doc();
  code(await join(a, doc), 'NOT_SUBSCRIBED');
  ok(await a.emitWithAck('room:join', { roomId }));
  ok(await b.emitWithAck('room:join', { roomId }));
  const other = await connect(outsider);
  code(await join(other, doc), 'ROOM_NOT_FOUND');
  code(await join(a, doc, randomUUID()), 'FILE_NOT_FOUND');
  const otherRoom = (await owner.post('/api/rooms').set(headers).send({ name: 'Second room' })).body
    .room.id;
  const otherFile = (await owner.get(`/api/rooms/${otherRoom}`)).body.files[0].id;
  code(await join(a, doc, otherFile), 'FILE_NOT_FOUND');
  doc.destroy();
});
test('concurrent first opens seed exactly once and legacy HTTP writes cannot overwrite CRDT state', async () => {
  const one = new Y.Doc(),
    two = new Y.Doc();
  const results = await Promise.all([join(a, one), join(b, two)]);
  Y.applyUpdate(one, dec(ok(results[0]).update));
  Y.applyUpdate(two, dec(ok(results[1]).update));
  assert.equal(one.getText('content').toString(), 'existing content');
  assert.equal(enc(Y.encodeStateAsUpdate(one)), enc(Y.encodeStateAsUpdate(two)));
  const rows = await connection.db.select().from(documents).where(eq(documents.fileId, fileId));
  assert.equal(rows.length, 1);
  const response = await owner
    .patch(`/api/files/${fileId}`)
    .set(headers)
    .send({ content: 'stale', version: 2 })
    .expect(409);
  assert.equal(response.body.error.code, 'COLLABORATIVE_DOCUMENT');
  one.destroy();
  two.destroy();
});
test('concurrent edits, duplicate delivery and disconnected edits converge and commit before ack', async () => {
  const one = new Y.Doc(),
    two = new Y.Doc();
  Y.applyUpdate(one, dec(ok(await join(a, one)).update));
  Y.applyUpdate(two, dec(ok(await join(b, two)).update));
  const base = Y.encodeStateVector(one);
  one.getText('content').insert(0, 'Alice ');
  two.getText('content').insert(0, 'Bob ');
  const responses = await Promise.all([write(a, one, base), write(b, two, base)]);
  responses.forEach(ok);
  const before = (await owner.get(`/api/files/${fileId}`)).body.file;
  assert.match(before.content, /Alice/);
  assert.match(before.content, /Bob/);
  ok(await write(a, one, base));
  const duplicate = (await owner.get(`/api/files/${fileId}`)).body.file;
  assert.equal(duplicate.version, before.version);
  one.getText('content').insert(one.getText('content').length, ' offline');
  Y.applyUpdate(one, dec(ok(await join(a, one)).update));
  ok(await write(a, one));
  Y.applyUpdate(two, dec(ok(await join(b, two)).update));
  assert.equal(one.getText('content').toString(), two.getText('content').toString());
  assert.match(two.getText('content').toString(), /offline/);
  one.destroy();
  two.destroy();
});
test('malformed, non-text, oversized and identity-spoofed updates fail without altering durable content', async () => {
  const before = (await owner.get(`/api/files/${fileId}`)).body.file;
  for (const update of ['AA==', '!!!']) {
    const result = await a.emitWithAck('doc:update', { roomId, fileId, update, vector: 'AA==' });
    assert.equal(result.ok, false);
  }
  for (const change of [
    (d: Y.Doc) => d.getMap('evil').set('key', 'value'),
    (d: Y.Doc) => d.getText('content').insert(0, 'x'.repeat(200001)),
    (d: Y.Doc) => d.getMap('content').set('hidden', 'value'),
  ]) {
    const bad = new Y.Doc();
    change(bad);
    code(await write(a, bad), 'INVALID_DOCUMENT');
    bad.destroy();
  }
  // Strict schema rejects identity fields even when the cursor itself is valid.
  const spoof = { roomId, fileId, cursor: null, user: { name: 'Forged' } };
  code(await a.emitWithAck('doc:awareness', spoof), 'VALIDATION_ERROR');
  assert.deepEqual((await owner.get(`/api/files/${fileId}`)).body.file, before);
});
test('awareness uses authenticated names, distinguishes tabs, cleans on leave, and viewer writes are blocked immediately', async () => {
  const one = new Y.Doc(),
    two = new Y.Doc();
  Y.applyUpdate(one, dec(ok(await join(a, one)).update));
  Y.applyUpdate(two, dec(ok(await join(b, two)).update));
  const observed = new Promise<DocumentPeer[]>((resolve) =>
    a.once('doc:awareness', (data) => resolve(data.peers)),
  );
  ok(await b.emitWithAck('doc:awareness', { roomId, fileId, cursor: null }));
  assert.ok(
    (await observed).some((p) => p.user.name === 'Doc editor' && p.clientId === two.clientID),
  );
  await owner
    .patch(`/api/rooms/${roomId}/members/${editorId}`)
    .set(headers)
    .send({ role: 'VIEWER' })
    .expect(204);
  two.getText('content').insert(0, 'forbidden');
  code(await write(b, two), 'FORBIDDEN');
  const latest = ok(await join(b, two));
  assert.equal(latest.role, 'VIEWER');
  ok(await b.emitWithAck('doc:awareness', { roomId, fileId, cursor: null }));
  const left = new Promise<DocumentPeer[]>((resolve) =>
    a.once('doc:awareness', (data) => resolve(data.peers)),
  );
  ok(await b.emitWithAck('doc:leave', { roomId, fileId }));
  assert.equal((await left).length, 1);
  await owner
    .patch(`/api/rooms/${roomId}/members/${editorId}`)
    .set(headers)
    .send({ role: 'EDITOR' })
    .expect(204);
  one.destroy();
  two.destroy();
});
test('failed persistence never acknowledges or broadcasts success; the same local update retries safely', async () => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, dec(ok(await join(a, doc)).update));
  doc.getText('content').insert(0, 'retry after database failure ');
  const before = (await owner.get(`/api/files/${fileId}`)).body.file;
  let broadcasts = 0;
  const count = () => {
    broadcasts++;
  };
  b.on('doc:update', count);
  // Force the projection write to fail after the document snapshot write. The transaction
  // must roll back both, and classify the failure as retryable rather than malformed input.
  await connection.db.execute(
    sql.raw(
      `CREATE OR REPLACE FUNCTION test_document_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test persistence outage'; END; $$`,
    ),
  );
  await connection.db.execute(
    sql.raw(
      `CREATE TRIGGER test_document_failure BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION test_document_failure()`,
    ),
  );
  try {
    code(await write(a, doc), 'UNAVAILABLE');
    assert.deepEqual((await owner.get(`/api/files/${fileId}`)).body.file, before);
    assert.equal(broadcasts, 0);
    const recovered = new Y.Doc();
    Y.applyUpdate(recovered, dec(ok(await join(b, recovered)).update));
    assert.equal(recovered.getText('content').toString(), before.content);
    recovered.destroy();
  } finally {
    await connection.db.execute(sql.raw('DROP TRIGGER test_document_failure ON files'));
    await connection.db.execute(sql.raw('DROP FUNCTION test_document_failure()'));
    b.off('doc:update', count);
  }
  ok(await write(a, doc));
  assert.equal(
    (await owner.get(`/api/files/${fileId}`)).body.file.content,
    doc.getText('content').toString(),
  );
  doc.destroy();
});

test(
  'stale cursor snapshots expire and disconnect removes only the departed document session',
  { timeout: 10_000 },
  async () => {
    const one = new Y.Doc(),
      two = new Y.Doc();
    ok(await join(a, one));
    ok(await join(b, two));
    // Age just the awareness timestamp; changing the global clock also expires transport timers.
    const session = gateway.sockets.sockets.get(b.id!);
    assert.ok(session?.data.document);
    session.data.document.seen = Date.now() - 46_000;
    const stale = new Promise<DocumentPeer[]>((resolve) =>
      a.once('doc:awareness', (data) => resolve(data.peers)),
    );
    ok(await a.emitWithAck('doc:awareness', { roomId, fileId, cursor: null }));
    assert.deepEqual(
      (await stale).map((peer) => peer.clientId),
      [one.clientID],
    );
    const refreshed = new Promise<DocumentPeer[]>((resolve) =>
      a.once('doc:awareness', (data) => resolve(data.peers)),
    );
    ok(await b.emitWithAck('doc:awareness', { roomId, fileId, cursor: null }));
    assert.equal((await refreshed).length, 2);
    const disconnected = new Promise<DocumentPeer[]>((resolve) =>
      a.once('doc:awareness', (data) => resolve(data.peers)),
    );
    b.disconnect();
    assert.equal((await disconnected).length, 1);
    one.destroy();
    two.destroy();
  },
);

test('gateway restart recovers durable CRDT identities and merges retained offline edits without duplicate seed text', async () => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, dec(ok(await join(a, doc)).update));
  doc.getText('content').insert(0, 'restart recovery ');
  await realtime.close();
  await start();
  owner = request.agent(app).set('Cookie', cookies.get('Doc owner')!);
  editor = request.agent(app).set('Cookie', cookies.get('Doc editor')!);
  a = await connect();
  b = await connect(editor);
  ok(await a.emitWithAck('room:join', { roomId }));
  ok(await b.emitWithAck('room:join', { roomId }));
  Y.applyUpdate(doc, dec(ok(await join(a, doc)).update));
  ok(await write(a, doc));
  const file = (await owner.get(`/api/files/${fileId}`)).body.file;
  assert.equal(file.content, doc.getText('content').toString());
  assert.equal(file.content.split('existing content').length, 2);
  doc.destroy();
});
test('switching files, folder deletion, and offline member removal invalidate old subscriptions', async () => {
  const doc = new Y.Doc();
  ok(await join(b, doc));
  const folder = (
    await owner
      .post(`/api/rooms/${roomId}/files`)
      .set(headers)
      .send({ name: 'folder', kind: 'FOLDER' })
  ).body.file;
  const file = (
    await owner
      .post(`/api/rooms/${roomId}/files`)
      .set(headers)
      .send({ name: 'child.ts', parentId: folder.id })
  ).body.file;
  const next = new Y.Doc();
  ok(await join(a, next, file.id));
  code(await write(a, doc), 'NOT_SUBSCRIBED');
  const revoked = new Promise<void>((resolve) => a.once('doc:revoked', () => resolve()));
  await owner.delete(`/api/files/${folder.id}`).set(headers).expect(204);
  await revoked;
  code(await join(a, next, file.id), 'FILE_NOT_FOUND');
  await owner.delete(`/api/rooms/${roomId}/members/${editorId}`).set(headers).expect(204);
  code(await join(b, doc), 'ROOM_NOT_FOUND');
  code(await write(b, doc), 'ROOM_NOT_FOUND');
  const remaining = await connection.db
    .select()
    .from(documents)
    .where(eq(documents.fileId, file.id));
  assert.equal(remaining.length, 0);
  doc.destroy();
  next.destroy();
});
