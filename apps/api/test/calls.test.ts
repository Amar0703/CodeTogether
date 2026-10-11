import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { eq } from 'drizzle-orm';
import { connectDatabase, sessions } from '@codetogether/db';
import type {
  ClientEvents,
  ServerEvents,
  RealtimeResult,
  CallJoined,
  CallSignal,
} from '@codetogether/contracts';
import { createApp } from '../src/app.js';
import { Realtime } from '../src/realtime.js';
import { hashToken } from '../src/security.js';
import { iceEnvironmentSchema, issueIce } from '../src/ice.js';

const origin = 'http://localhost:3000';
const headers = { Origin: origin, 'X-CodeTogether': '1' };
const media = { microphone: true, camera: false };
type Client = Socket<ServerEvents, ClientEvents>;
let db: Awaited<ReturnType<typeof connectDatabase>>, realtime: Realtime, url: string;
let app: ReturnType<typeof createApp>;
const clients: Client[] = [];
function ok<T>(r: RealtimeResult<T>): T {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.data;
}
function code<T>(r: RealtimeResult<T>, expected: string) {
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, expected);
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
before(async () => {
  db = await connectDatabase(process.env.TEST_DATABASE_URL);
  await db.migrate();
  realtime = new Realtime(db.db, origin, { sweepMs: 50 });
  app = createApp(db.db, { origin, realtime, rateLimit: 1000 });
  const server = createServer(app);
  realtime.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  url = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  clients.forEach((s) => s.disconnect());
  await realtime.close();
  await db.close();
});
async function fixture() {
  const owner = request.agent(app),
    viewer = request.agent(app),
    outsider = request.agent(app);
  let viewerId = '',
    viewerHash = '';
  for (const [agent, name] of [
    [owner, 'Call owner'],
    [viewer, 'Call viewer'],
    [outsider, 'Outsider'],
  ] as const) {
    const r = await agent
      .post('/api/auth/signup')
      .set(headers)
      .send({ name, email: `${randomUUID()}@example.com`, password: 'call test password' })
      .expect(201);
    if (agent === viewer) {
      viewerId = r.body.user.id;
      viewerHash = hashToken(r.headers['set-cookie'][0].split(';')[0].split('=')[1]);
    }
  }
  const roomId = (
    await owner.post('/api/rooms').set(headers).send({ name: 'Call tests' }).expect(201)
  ).body.room.id as string;
  const token = (
    await owner
      .post(`/api/rooms/${roomId}/invites`)
      .set(headers)
      .send({ role: 'VIEWER' })
      .expect(201)
  ).body.url
    .split('/')
    .at(-1);
  await viewer.post(`/api/invites/${token}/join`).set(headers).expect(200);
  async function connect(agent = owner, room = roomId) {
    const ticket = (await agent.post('/api/realtime/ticket').set(headers).expect(200)).body.ticket;
    const socket: Client = io(url, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { ticket },
      extraHeaders: { Origin: origin },
    });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    ok(await socket.timeout(3000).emitWithAck('room:join', { roomId: room }));
    return socket;
  }
  const join = async (socket: Client) =>
    ok<CallJoined>(
      await socket.timeout(3000).emitWithAck('call:join', { roomId, joinId: randomUUID(), media }),
    );
  return { owner, viewer, outsider, viewerId, viewerHash, roomId, connect, join };
}
function signal(a: CallJoined, b: CallJoined, sequence = 1): CallSignal {
  return {
    ...a.session,
    to: b.session.participantId,
    sequence,
    signal: { kind: 'description', type: 'offer', sdp: 'v=0\r\n' },
  };
}
test('call authentication, isolation, identities, destination authorization, duplicate and stale sessions', async () => {
  const f = await fixture();
  const a = await f.connect(),
    b = await f.connect(f.viewer);
  const otherRoom = (
    await f.outsider.post('/api/rooms').set(headers).send({ name: 'Other call' }).expect(201)
  ).body.room.id;
  const c = await f.connect(f.outsider, otherRoom);
  code(
    await c.emitWithAck('call:join', { roomId: f.roomId, joinId: randomUUID(), media }),
    'ROOM_NOT_FOUND',
  );
  const ca = await f.join(a),
    cb = await f.join(b);
  assert.equal(
    cb.snapshot.participants.find((p) => p.id === cb.session.participantId)?.name,
    'Call viewer',
  );
  let received = 0;
  b.on('call:signal', () => received++);
  ok(await a.emitWithAck('call:signal', signal(ca, cb)));
  ok(await a.emitWithAck('call:signal', signal(ca, cb)));
  await delay(30);
  assert.equal(received, 1);
  code(
    await a.emitWithAck('call:signal', {
      ...signal(ca, cb, 2),
      participantId: cb.session.participantId,
    }),
    'STALE_CALL',
  );
  code(await a.emitWithAck('call:signal', { ...signal(ca, cb, 2), to: randomUUID() }), 'PEER_GONE');
  const cc = ok<CallJoined>(
    await c.emitWithAck('call:join', { roomId: otherRoom, joinId: randomUUID(), media }),
  );
  code(await a.emitWithAck('call:signal', signal(ca, cc, 2)), 'PEER_GONE');
  const forged = { ...signal(ca, cb, 2), userId: f.viewerId };
  code(await a.emitWithAck('call:signal', forged), 'VALIDATION_ERROR');
  ok(await b.emitWithAck('call:leave', cb.session));
  const cb2 = await f.join(b);
  assert.notEqual(cb2.session.participantId, cb.session.participantId);
  code(await a.emitWithAck('call:signal', signal(ca, cb, 3)), 'PEER_GONE');
  code(await b.emitWithAck('call:state', { ...cb.session, media }), 'STALE_CALL');
  ok(await a.emitWithAck('call:leave', ca.session));
  ok(await b.emitWithAck('call:leave', cb2.session));
  const ca2 = await f.join(a);
  assert.notEqual(ca2.session.callId, ca.session.callId);
  code(await a.emitWithAck('call:leave', ca.session), 'STALE_CALL');
  [a, b, c].forEach((s) => s.disconnect());
});
test('malformed/oversize signals, four tab slots, and event rates leave chat usable', async () => {
  const f = await fixture();
  const sockets = await Promise.all(Array.from({ length: 5 }, () => f.connect()));
  const joined = await Promise.all(sockets.slice(0, 4).map(f.join));
  assert.equal(new Set(joined.map((j) => j.session.participantId)).size, 4);
  code(
    await sockets[4].emitWithAck('call:join', { roomId: f.roomId, joinId: randomUUID(), media }),
    'CALL_FULL',
  );
  const a = sockets[0],
    valid = signal(joined[0], joined[1]);
  for (const sdp of ['', 'x'.repeat(65_537)])
    code(
      await a.emitWithAck('call:signal', {
        ...valid,
        signal: { kind: 'description', type: 'offer', sdp },
      }),
      'VALIDATION_ERROR',
    );
  code(
    await a.emitWithAck('call:signal', {
      ...valid,
      signal: {
        kind: 'candidate',
        candidate: 'x'.repeat(2049),
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'test',
      },
    }),
    'VALIDATION_ERROR',
  );
  for (let i = 0; i < 60; i++)
    ok(await a.emitWithAck('call:state', { ...joined[0].session, media }));
  code(await a.emitWithAck('call:state', { ...joined[0].session, media }), 'RATE_LIMITED');
  ok(
    await a.emitWithAck('chat:send', {
      roomId: f.roomId,
      clientMessageId: randomUUID(),
      body: 'Chat survives media limits',
    }),
  );
  await sockets[3].emitWithAck('room:leave', { roomId: f.roomId });
  assert.equal((await f.join(sockets[4])).snapshot.participants.length, 4);
  sockets.forEach((s) => s.disconnect());
});
test('removal, logout, expiry, room deletion and disconnect remove media participation', async () => {
  for (const reason of ['removal', 'logout', 'expiry', 'deletion', 'disconnect'] as const) {
    const f = await fixture(),
      a = await f.connect(),
      b = await f.connect(f.viewer);
    const ca = await f.join(a),
      cb = await f.join(b);
    const ended = new Promise<void>((resolve) => {
      a.on('call:snapshot', (s) => {
        if (!s.participants.some((p) => p.id === cb.session.participantId)) resolve();
      });
      a.on('room:revoked', () => resolve());
    });
    if (reason === 'removal')
      await f.owner.delete(`/api/rooms/${f.roomId}/members/${f.viewerId}`).set(headers).expect(204);
    if (reason === 'logout') await f.viewer.post('/api/auth/logout').set(headers).expect(204);
    if (reason === 'expiry')
      await db.db
        .update(sessions)
        .set({ expiresAt: new Date(0) })
        .where(eq(sessions.tokenHash, f.viewerHash));
    if (reason === 'deletion')
      await f.owner.delete(`/api/rooms/${f.roomId}`).set(headers).expect(204);
    if (reason === 'disconnect') b.disconnect();
    await Promise.race([
      ended,
      delay(3000).then(() => {
        throw new Error(`Cleanup failed: ${reason}`);
      }),
    ]);
    if (reason !== 'deletion')
      code(await a.emitWithAck('call:signal', signal(ca, cb)), 'PEER_GONE');
    a.disconnect();
    b.disconnect();
  }
});
test('ICE issuance validates configuration, uses expiring HMAC credentials, enforces membership, CSRF, no-store and limits', async () => {
  const secret = 'test-only-shared-secret-32-characters';
  const settings = iceEnvironmentSchema.parse({
    TURN_URLS: 'turn:relay.example:3478?transport=udp,turns:relay.example:5349?transport=tcp',
    TURN_SHARED_SECRET: secret,
  });
  const ice = issueIce(settings),
    server = ice.iceServers[0];
  assert.equal(
    server.credential,
    createHmac('sha1', secret).update(server.username!).digest('base64'),
  );
  assert.ok(Date.parse(ice.expiresAt) > Date.now() + 590_000);
  assert.notEqual(issueIce(settings).iceServers[0].username, server.username);
  assert.equal(JSON.stringify(ice).includes(secret), false);
  for (const config of [
    { TURN_URLS: 'turn:x:3478' },
    { ICE_TRANSPORT_POLICY: 'relay' },
    { STUN_URLS: 'https://bad.example' },
  ])
    assert.equal(iceEnvironmentSchema.safeParse(config).success, false);
  const f = await fixture(),
    path = `/api/rooms/${f.roomId}/ice`;
  await request(app).post(path).set(headers).expect(401);
  await f.owner.post(path).expect(403);
  await f.owner
    .post(path)
    .set({ ...headers, Origin: 'https://evil.example' })
    .expect(403);
  await f.outsider.post(path).set(headers).expect(404);
  await f.owner.post('/api/rooms/not-a-uuid/ice').set(headers).expect(400);
  for (let i = 0; i < 12; i++) {
    const res = await f.viewer.post(path).set(headers).expect(200);
    assert.match(res.headers['cache-control'], /no-store/);
    assert.equal(res.body.turnConfigured, false);
  }
  await f.viewer.post(path).set(headers).expect(429);
});
