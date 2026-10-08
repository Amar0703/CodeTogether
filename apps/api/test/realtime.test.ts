import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { eq } from 'drizzle-orm';
import { connectDatabase, sessions, messages } from '@codetogether/db';
import type {
  ChatMessage,
  ClientEvents,
  Presence,
  RealtimeResult,
  ServerEvents,
} from '@codetogether/contracts';
import { createApp } from '../src/app.js';
import { Realtime } from '../src/realtime.js';
import { normalizeOrigin } from '../src/origin.js';
import { hashToken } from '../src/security.js';

const origin = 'http://localhost:3000';
const headers = { Origin: origin, 'X-CodeTogether': '1' };
type Client = Socket<ServerEvents, ClientEvents>;
let db: Awaited<ReturnType<typeof connectDatabase>>;
let realtime: Realtime, app: ReturnType<typeof createApp>, url: string;
let owner: ReturnType<typeof request.agent>,
  member: ReturnType<typeof request.agent>,
  outsider: ReturnType<typeof request.agent>;
let ownerId: string,
  memberId: string,
  memberHash: string,
  roomId: string,
  otherRoom: string,
  fileId: string;
const clients: Client[] = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await delay(20);
  assert.ok(check(), 'Expected realtime state before deadline');
}
function connect(ticket?: string, suppliedOrigin: string | undefined = origin): Client {
  const socket: Client = io(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: ticket ? { ticket } : {},
    extraHeaders: suppliedOrigin ? { Origin: suppliedOrigin } : {},
  });
  clients.push(socket);
  return socket;
}
async function ticket(agent = owner) {
  return (await agent.post('/api/realtime/ticket').set(headers).expect(200)).body.ticket as string;
}
async function connected(agent = owner) {
  const socket = connect(await ticket(agent));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}
async function rejected(socket: Client) {
  await new Promise<void>((resolve, reject) => {
    socket.once('connect_error', () => resolve());
    socket.once('connect', () => reject(new Error('Unexpected connection')));
  });
  socket.disconnect();
}
function join(socket: Client, id = roomId): Promise<RealtimeResult<Presence>> {
  return socket.timeout(2000).emitWithAck('room:join', { roomId: id });
}
function send(
  socket: Client,
  body: string,
  clientMessageId = randomUUID(),
  id = roomId,
): Promise<RealtimeResult<ChatMessage>> {
  return socket.timeout(2000).emitWithAck('chat:send', { roomId: id, body, clientMessageId });
}
function ok<T>(result: RealtimeResult<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
function code<T>(result: RealtimeResult<T>, expected: string) {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, expected);
}
before(async () => {
  db = await connectDatabase(process.env.TEST_DATABASE_URL);
  await db.migrate();
  realtime = new Realtime(db.db, origin + '/', {
    sweepMs: 100,
    ticketTtlMs: 500,
    pingInterval: 100,
    pingTimeout: 150,
  });
  app = createApp(db.db, { origin: origin + '/', realtime, rateLimit: 1000 });
  const server = createServer(app);
  realtime.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  url = `http://127.0.0.1:${address.port}`;
  owner = request.agent(app);
  member = request.agent(app);
  outsider = request.agent(app);
  for (const [agent, name] of [
    [owner, 'Realtime owner'],
    [member, 'Realtime member'],
    [outsider, 'Realtime outsider'],
  ] as const) {
    const res = await agent
      .post('/api/auth/signup')
      .set(headers)
      .send({ name, email: `${randomUUID()}@example.com`, password: 'correct horse battery' })
      .expect(201);
    if (agent === owner) ownerId = res.body.user.id;
    if (agent === member) {
      memberId = res.body.user.id;
      memberHash = hashToken(res.headers['set-cookie'][0].split(';')[0].split('=')[1]);
    }
  }
  roomId = (await owner.post('/api/rooms').set(headers).send({ name: 'Realtime test' }).expect(201))
    .body.room.id;
  otherRoom = (
    await outsider.post('/api/rooms').set(headers).send({ name: 'Isolated room' }).expect(201)
  ).body.room.id;
  fileId = (await owner.get(`/api/rooms/${roomId}`).expect(200)).body.files[0].id;
  const invite = (
    await owner
      .post(`/api/rooms/${roomId}/invites`)
      .set(headers)
      .send({ role: 'EDITOR' })
      .expect(201)
  ).body.url
    .split('/')
    .at(-1);
  await member.post(`/api/invites/${invite}/join`).set(headers).expect(200);
});
after(async () => {
  clients.forEach((s) => s.disconnect());
  await realtime?.close();
  await db?.close();
});

test('origin normalization accepts a trailing slash but rejects paths and credentials', () => {
  assert.equal(normalizeOrigin(origin + '/'), origin);
  for (const value of [
    origin + '/path',
    origin + '?x=1',
    'https://user:password@example.com',
    'file:///tmp',
  ])
    assert.throws(() => normalizeOrigin(value));
});
test('socket tickets require session and CSRF; handshakes reject missing, invalid, expired, replayed and foreign-origin credentials', async () => {
  await request(app).post('/api/realtime/ticket').set(headers).expect(401);
  await owner.post('/api/realtime/ticket').expect(403);
  await owner
    .post('/api/realtime/ticket')
    .set({ ...headers, Origin: 'https://evil.example' })
    .expect(403);
  await rejected(connect());
  await rejected(connect('0'.repeat(64)));
  await rejected(connect(await ticket(), 'https://evil.example'));
  await rejected(connect(await ticket(), ''));
  const expired = await ticket();
  await delay(550);
  await rejected(connect(expired));
  const single = await ticket();
  const first = connect(single);
  await eventually(() => first.connected);
  await rejected(connect(single));
  first.disconnect();
});
test('unauthorized joins and sends are rejected; client identities and malformed payloads cannot override server identity', async () => {
  const socket = await connected(outsider);
  code(await join(socket), 'ROOM_NOT_FOUND');
  code(await send(socket, 'intrusion'), 'NOT_SUBSCRIBED');
  code(await join(socket, 'invalid'), 'VALIDATION_ERROR');
  const mine = await connected();
  ok(await join(mine));
  const forged = {
    roomId,
    body: 'forged',
    clientMessageId: randomUUID(),
    userId: memberId,
    role: 'OWNER',
  };
  code(await mine.timeout(2000).emitWithAck('chat:send', forged), 'VALIDATION_ERROR');
  code(await send(mine, ' '.repeat(5)), 'VALIDATION_ERROR');
  code(await send(mine, 'x'.repeat(2001)), 'VALIDATION_ERROR');
  mine.disconnect();
  socket.disconnect();
});
test('presence counts users across tabs, leaves, abrupt transport loss and fresh-ticket reconnect', async () => {
  const alice = await connected(),
    bob = await connected(member),
    bobTab = await connected(member);
  let presence: Presence | undefined;
  alice.on('presence:update', (value) => {
    presence = value;
  });
  ok(await join(alice));
  ok(await join(bob));
  ok(await join(bobTab));
  await eventually(() => presence?.members.length === 2);
  bob.disconnect();
  await delay(150);
  assert.equal(presence?.members.length, 2);
  ok(await bobTab.timeout(2000).emitWithAck('room:leave', { roomId }));
  await eventually(() => presence?.members.length === 1);
  ok(await join(bobTab));
  await eventually(() => presence?.members.length === 2);
  // Simulate a half-open client that stops answering ping packets.
  bobTab.io.engine.transport.removeAllListeners('packet');
  await eventually(() => presence?.members.length === 1);
  bobTab.disconnect();
  const recovered = await connected(member);
  ok(await join(recovered));
  await eventually(() => presence?.members.length === 2);
  alice.disconnect();
  recovered.disconnect();
});
test('chat commits before ack, preserves sender/time, paginates without gaps and isolates rooms', async () => {
  const alice = await connected(),
    bob = await connected(member),
    stranger = await connected(outsider);
  ok(await join(alice));
  ok(await join(bob));
  ok(await join(stranger, otherRoom));
  const received: ChatMessage[] = [],
    leaked: ChatMessage[] = [];
  bob.on('chat:message', (value) => received.push(value));
  stranger.on('chat:message', (value) => leaked.push(value));
  const sent: ChatMessage[] = [];
  for (let i = 0; i < 5; i++) sent.push(ok(await send(alice, `message ${i}`)));
  await eventually(() => received.length === 5);
  assert.equal(leaked.length, 0);
  assert.equal(sent[0].sender.id, ownerId);
  assert.equal(sent[0].sender.name, 'Realtime owner');
  assert.ok(Number.isFinite(Date.parse(sent[0].createdAt)));
  let cursor: string | null = null;
  const history: ChatMessage[] = [];
  do {
    const page: request.Response = await member
      .get(`/api/rooms/${roomId}/messages?limit=2${cursor ? `&before=${cursor}` : ''}`)
      .expect(200);
    history.unshift(...page.body.messages);
    cursor = page.body.nextCursor;
  } while (cursor);
  assert.deepEqual(
    history.map((m) => m.id),
    sent.map((m) => m.id),
  );
  await outsider.get(`/api/rooms/${roomId}/messages`).expect(404);
  await owner.get(`/api/rooms/${roomId}/messages?limit=101`).expect(400);
  await owner.get(`/api/rooms/${roomId}/messages?before=1&after=2`).expect(400);
  bob.disconnect();
  const missed = ok(await send(alice, 'while disconnected'));
  const resumed = await connected(member);
  ok(await join(resumed));
  const catchup = await member
    .get(`/api/rooms/${roomId}/messages?after=${sent.at(-1)!.sequence}`)
    .expect(200);
  assert.deepEqual(
    catchup.body.messages.map((m: ChatMessage) => m.id),
    [missed.id],
  );
  alice.disconnect();
  resumed.disconnect();
  stranger.disconnect();
});
test('lost acknowledgments and concurrent retries reuse one durable message, including after gateway restart', async () => {
  const alice = await connected(),
    second = await connected();
  ok(await join(alice));
  ok(await join(second));
  const id = randomUUID();
  // Ignore the first acknowledgment, as if it were lost in transit.
  alice.emit('chat:send', { roomId, body: 'retry safely', clientMessageId: id }, () => {});
  const [one, two] = await Promise.all([
    send(alice, 'retry safely', id),
    send(second, 'retry safely', id),
  ]);
  assert.equal(ok(one).id, ok(two).id);
  code(await send(alice, 'different body', id), 'IDEMPOTENCY_CONFLICT');
  assert.equal(
    (await db.db.select().from(messages).where(eq(messages.clientMessageId, id))).length,
    1,
  );
  alice.disconnect();
  second.disconnect();
  await realtime.close();
  realtime = new Realtime(db.db, origin, { sweepMs: 100 });
  app = createApp(db.db, { origin, realtime, rateLimit: 1000 });
  const server = createServer(app);
  realtime.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  url = `http://127.0.0.1:${address.port}`;
  // Existing HTTP agents use the first app but share the database. Get a ticket on the restarted app.
  const agent = request.agent(app);
  await agent
    .post('/api/auth/login')
    .set(headers)
    .send({
      email: (await owner.get('/api/auth/me')).body.user.email,
      password: 'correct horse battery',
    })
    .expect(200);
  const recovered = await connected(agent);
  ok(await join(recovered));
  assert.equal(ok(await send(recovered, 'retry safely', id)).id, ok(one).id);
  recovered.disconnect();
  // Continue the remaining tests with HTTP agents attached to the active gateway.
  for (const [old, kind] of [
    [owner, 'owner'],
    [member, 'member'],
    [outsider, 'outsider'],
  ] as const) {
    const email = (await old.get('/api/auth/me')).body.user.email;
    const next = request.agent(app);
    const response = await next
      .post('/api/auth/login')
      .set(headers)
      .send({ email, password: 'correct horse battery' })
      .expect(200);
    if (kind === 'owner') owner = next;
    if (kind === 'member') {
      member = next;
      memberHash = hashToken(response.headers['set-cookie'][0].split(';')[0].split('=')[1]);
    }
    if (kind === 'outsider') outsider = next;
  }
});
test('role changes update existing sockets and file permissions; removal evicts every tab before further delivery', async () => {
  const alice = await connected(),
    bob = await connected(member),
    bobTab = await connected(member);
  ok(await join(alice));
  ok(await join(bob));
  ok(await join(bobTab));
  let presence: Presence | undefined,
    changes = 0,
    revoked = 0,
    delivered = 0;
  bob.on('presence:update', (value) => {
    presence = value;
  });
  bob.on('room:event', () => changes++);
  bob.on('room:revoked', () => revoked++);
  bobTab.on('room:revoked', () => revoked++);
  bob.on('chat:message', () => delivered++);
  await owner
    .patch(`/api/rooms/${roomId}/members/${memberId}`)
    .set(headers)
    .send({ role: 'VIEWER' })
    .expect(204);
  await eventually(
    () => presence?.members.find((m) => m.id === memberId)?.role === 'VIEWER' && changes > 0,
  );
  await member
    .patch(`/api/files/${fileId}`)
    .set(headers)
    .send({ content: 'blocked', version: 1 })
    .expect(403);
  ok(await send(bob, 'viewers may chat'));
  await eventually(() => delivered === 1);
  await owner.delete(`/api/rooms/${roomId}/members/${memberId}`).set(headers).expect(204);
  await eventually(() => revoked === 2);
  code(await send(bob, 'removed'), 'NOT_SUBSCRIBED');
  code(await join(bobTab), 'ROOM_NOT_FOUND');
  ok(await send(alice, 'private after removal'));
  await delay(100);
  assert.equal(delivered, 1);
  await member.get(`/api/rooms/${roomId}/messages`).expect(404);
  alice.disconnect();
  bob.disconnect();
  bobTab.disconnect();
});
test('typed file events remain room scoped and deleted rooms revoke connected owners', async () => {
  const alice = await connected(),
    stranger = await connected(outsider);
  ok(await join(alice));
  ok(await join(stranger, otherRoom));
  let eventType = '',
    leaks = 0,
    revoked = false;
  alice.on('room:event', (event) => {
    eventType = event.type;
  });
  stranger.on('room:event', () => leaks++);
  await owner
    .patch(`/api/files/${fileId}`)
    .set(headers)
    .send({ content: 'saved explicitly', version: 1 })
    .expect(200);
  await eventually(() => eventType === 'file.changed');
  assert.equal(leaks, 0);
  alice.on('room:revoked', () => {
    revoked = true;
  });
  await owner.delete(`/api/rooms/${roomId}`).set(headers).expect(204);
  await eventually(() => revoked);
  code(await join(alice), 'ROOM_NOT_FOUND');
  assert.equal((await db.db.select().from(messages).where(eq(messages.roomId, roomId))).length, 0);
  alice.disconnect();
  stranger.disconnect();
});
test('idle session expiry and logout disconnect existing sockets and invalidate issued tickets', async () => {
  const socket = await connected(member);
  await db.db
    .update(sessions)
    .set({ expiresAt: new Date(0) })
    .where(eq(sessions.tokenHash, memberHash));
  await eventually(() => !socket.connected);
  const alice = await connected();
  const unused = await ticket();
  await owner.post('/api/auth/logout').set(headers).expect(204);
  await eventually(() => !alice.connected);
  await rejected(connect(unused));
});
test('per-user chat limits apply across tabs and malformed floods are disconnected', async () => {
  const one = await connected(outsider),
    two = await connected(outsider);
  ok(await join(one, otherRoom));
  ok(await join(two, otherRoom));
  let limited = false;
  for (let i = 0; i < 31; i++) {
    const result = await send(i % 2 ? one : two, `bounded ${i}`, randomUUID(), otherRoom);
    if (!result.ok && result.error.code === 'RATE_LIMITED') limited = true;
  }
  assert.equal(limited, true);
  for (let i = 0; i < 125; i++) one.emit('room:join', { roomId: 'malformed' }, () => {});
  await eventually(() => !one.connected);
  two.disconnect();
});
