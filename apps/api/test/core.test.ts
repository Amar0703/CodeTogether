import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { connectDatabase, invites, sessions } from '@codetogether/db';
import { createApp } from '../src/app.js';
import { hashToken } from '../src/security.js';

const origin = 'http://localhost:3000';
const headers = { 'X-CodeTogether': '1', Origin: origin };
let connection: Awaited<ReturnType<typeof connectDatabase>>;
let app: ReturnType<typeof createApp>;
let alice: ReturnType<typeof request.agent>,
  bob: ReturnType<typeof request.agent>,
  viewer: ReturnType<typeof request.agent>,
  outsider: ReturnType<typeof request.agent>;
let aliceId: string, bobId: string, roomId: string, fileId: string;
before(async () => {
  connection = await connectDatabase(process.env.TEST_DATABASE_URL);
  await connection.migrate();
  app = createApp(connection.db, { origin, rateLimit: 1000 });
  alice = request.agent(app);
  bob = request.agent(app);
  viewer = request.agent(app);
  outsider = request.agent(app);
  for (const [agent, name] of [
    [alice, 'Alice'],
    [bob, 'Bob'],
    [viewer, 'Viewer'],
    [outsider, 'Outsider'],
  ] as const) {
    const res = await agent
      .post('/api/auth/signup')
      .set(headers)
      .send({ name, email: `${name.toLowerCase()}@example.com`, password: 'correct horse battery' })
      .expect(201);
    assert.equal(res.body.user.passwordHash, undefined);
    assert.match(res.headers['set-cookie'][0], /HttpOnly/);
    assert.match(res.headers['set-cookie'][0], /SameSite=Lax/);
    if (name === 'Alice') aliceId = res.body.user.id;
    if (name === 'Bob') bobId = res.body.user.id;
  }
});
after(async () => {
  await connection?.close();
});

test('authentication rejects invalid credentials, duplicate identities and unauthenticated requests', async () => {
  await request(app).get('/api/rooms').expect(401);
  await request(app)
    .post('/api/auth/login')
    .set(headers)
    .send({ email: 'alice@example.com', password: 'wrong password' })
    .expect(401);
  await request(app)
    .post('/api/auth/signup')
    .set(headers)
    .send({ name: 'Another', email: 'ALICE@example.com', password: 'correct horse battery' })
    .expect(409);
  await request(app)
    .post('/api/auth/signup')
    .set(headers)
    .send({ name: 'X', email: 'invalid', password: 'short' })
    .expect(400);
  const agent = request.agent(app);
  await agent
    .post('/api/auth/login')
    .set(headers)
    .send({ email: 'alice@example.com', password: 'correct horse battery' })
    .expect(200);
  await agent.post('/api/auth/logout').set(headers).expect(204);
  await agent.get('/api/auth/me').expect(401);
});
test('unsafe requests require a same-origin header and reject cross-site origins', async () => {
  await alice.post('/api/rooms').send({ name: 'Blocked room' }).expect(403);
  await alice
    .post('/api/rooms')
    .set({ ...headers, Origin: 'https://evil.example' })
    .send({ name: 'Blocked room' })
    .expect(403);
});
test('owner creates a private room and outsiders cannot enumerate its files', async () => {
  const created = await alice
    .post('/api/rooms')
    .set(headers)
    .send({ name: 'Binary Search Practice', description: 'Working through a problem' })
    .expect(201);
  roomId = created.body.room.id;
  const detail = await alice.get(`/api/rooms/${roomId}`).expect(200);
  fileId = detail.body.files[0].id;
  assert.equal(detail.body.room.role, 'OWNER');
  assert.equal(detail.body.members.length, 1);
  await outsider.get(`/api/rooms/${roomId}`).expect(404);
  await outsider.get(`/api/files/${fileId}`).expect(404);
  await outsider.post(`/api/rooms/${roomId}/join`).set(headers).expect(404);
  assert.deepEqual((await outsider.get('/api/rooms').expect(200)).body.rooms, []);
});
test('two accounts join one room, persist a file and reject stale saves without losing content', async () => {
  const invite = await alice
    .post(`/api/rooms/${roomId}/invites`)
    .set(headers)
    .send({ role: 'EDITOR' })
    .expect(201);
  const token = invite.body.url.split('/').pop();
  await bob.post(`/api/invites/${token}/join`).set(headers).expect(200);
  await bob.post(`/api/invites/${token}/join`).set(headers).expect(200);
  const shared = await bob.get(`/api/rooms/${roomId}`).expect(200);
  assert.equal(shared.body.members.length, 2);
  assert.equal(shared.body.room.role, 'EDITOR');
  const saved = await alice
    .patch(`/api/files/${fileId}`)
    .set(headers)
    .send({ content: 'const answer = 42;\n', version: 1 })
    .expect(200);
  assert.equal(saved.body.file.version, 2);
  const conflict = await bob
    .patch(`/api/files/${fileId}`)
    .set(headers)
    .send({ content: 'stale draft', version: 1 })
    .expect(409);
  assert.equal(conflict.body.error.code, 'VERSION_CONFLICT');
  assert.equal(
    (await bob.get(`/api/files/${fileId}`).expect(200)).body.file.content,
    'const answer = 42;\n',
  );
  await bob
    .patch(`/api/files/${fileId}`)
    .set(headers)
    .send({ content: 'const answer = 43;\n', version: 2 })
    .expect(200);
  assert.equal(
    (await alice.get(`/api/files/${fileId}`).expect(200)).body.file.content,
    'const answer = 43;\n',
  );
});
test('viewer can read but cannot mutate files, invites, memberships or room settings', async () => {
  const invitation = await alice
    .post(`/api/rooms/${roomId}/invites`)
    .set(headers)
    .send({ role: 'VIEWER' })
    .expect(201);
  await viewer
    .post(`/api/invites/${invitation.body.url.split('/').pop()}/join`)
    .set(headers)
    .expect(200);
  await viewer.get(`/api/files/${fileId}`).expect(200);
  await viewer
    .patch(`/api/files/${fileId}`)
    .set(headers)
    .send({ content: 'nope', version: 3 })
    .expect(403);
  await viewer
    .post(`/api/rooms/${roomId}/files`)
    .set(headers)
    .send({ name: 'nope.js' })
    .expect(403);
  await viewer
    .patch(`/api/files/${fileId}/name`)
    .set(headers)
    .send({ name: 'nope.js' })
    .expect(403);
  await viewer.delete(`/api/files/${fileId}`).set(headers).expect(403);
  await viewer
    .post(`/api/rooms/${roomId}/invites`)
    .set(headers)
    .send({ role: 'EDITOR' })
    .expect(403);
  await bob.patch(`/api/rooms/${roomId}`).set(headers).send({ name: 'No permission' }).expect(403);
  await bob.delete(`/api/rooms/${roomId}`).set(headers).expect(403);
  await bob
    .patch(`/api/rooms/${roomId}/members/${aliceId}`)
    .set(headers)
    .send({ role: 'VIEWER' })
    .expect(403);
});
test('folder rename updates descendants atomically; duplicate names and cross-room parents are rejected', async () => {
  const folder = (
    await alice
      .post(`/api/rooms/${roomId}/files`)
      .set(headers)
      .send({ name: 'src', kind: 'FOLDER' })
      .expect(201)
  ).body.file;
  const nested = (
    await bob
      .post(`/api/rooms/${roomId}/files`)
      .set(headers)
      .send({ name: 'search.py', parentId: folder.id })
      .expect(201)
  ).body.file;
  await bob
    .post(`/api/rooms/${roomId}/files`)
    .set(headers)
    .send({ name: 'search.py', parentId: folder.id })
    .expect(409);
  await bob.patch(`/api/files/${folder.id}/name`).set(headers).send({ name: 'lib' }).expect(204);
  assert.equal(
    (await bob.get(`/api/files/${nested.id}`).expect(200)).body.file.path,
    '/lib/search.py',
  );
  const otherRoom = (
    await alice.post('/api/rooms').set(headers).send({ name: 'Other Room' }).expect(201)
  ).body.room.id;
  await alice
    .post(`/api/rooms/${otherRoom}/files`)
    .set(headers)
    .send({ name: 'escape.js', parentId: folder.id })
    .expect(400);
  await alice
    .post(`/api/rooms/${roomId}/files`)
    .set(headers)
    .send({ name: '../escape.js' })
    .expect(400);
  await bob.delete(`/api/files/${folder.id}`).set(headers).expect(204);
  await bob.get(`/api/files/${nested.id}`).expect(404);
});
test('room owners manage permissions immediately and cannot demote or remove themselves', async () => {
  await alice
    .patch(`/api/rooms/${roomId}/members/${bobId}`)
    .set(headers)
    .send({ role: 'VIEWER' })
    .expect(204);
  await bob
    .patch(`/api/files/${fileId}`)
    .set(headers)
    .send({ content: 'denied', version: 3 })
    .expect(403);
  await alice
    .patch(`/api/rooms/${roomId}/members/${bobId}`)
    .set(headers)
    .send({ role: 'EDITOR' })
    .expect(204);
  await alice
    .patch(`/api/rooms/${roomId}/members/${aliceId}`)
    .set(headers)
    .send({ role: 'VIEWER' })
    .expect(400);
  await alice.delete(`/api/rooms/${roomId}/members/${aliceId}`).set(headers).expect(400);
  await bob.delete(`/api/rooms/${roomId}/members/${bobId}`).set(headers).expect(204);
  await bob.get(`/api/files/${fileId}`).expect(404);
});
test('public join grants only viewer access; existing ownership cannot be downgraded by an invite', async () => {
  const room = (
    await alice
      .post('/api/rooms')
      .set(headers)
      .send({ name: 'Public practice', visibility: 'PUBLIC' })
      .expect(201)
  ).body.room;
  await bob.post(`/api/rooms/${room.id}/join`).set(headers).expect(200);
  assert.equal((await bob.get(`/api/rooms/${room.id}`).expect(200)).body.room.role, 'VIEWER');
  const invite = (
    await alice
      .post(`/api/rooms/${room.id}/invites`)
      .set(headers)
      .send({ role: 'VIEWER' })
      .expect(201)
  ).body.url
    .split('/')
    .pop();
  await alice.post(`/api/invites/${invite}/join`).set(headers).expect(200);
  assert.equal((await alice.get(`/api/rooms/${room.id}`).expect(200)).body.room.role, 'OWNER');
});
test('expired invites and sessions are invalid; malformed parameters are validated', async () => {
  const value = 'a'.repeat(64);
  await connection.db.insert(invites).values({
    id: randomUUID(),
    roomId,
    tokenHash: hashToken(value),
    role: 'EDITOR',
    expiresAt: new Date(0),
  });
  await bob.post(`/api/invites/${value}/join`).set(headers).expect(400);
  await bob.get('/api/rooms/not-a-uuid').expect(400);
  await bob.post('/api/invites/invalid/join').set(headers).expect(400);
  await connection.db
    .update(sessions)
    .set({ expiresAt: new Date(0) })
    .where(eq(sessions.userId, bobId));
  await bob.get('/api/auth/me').expect(401);
});
test('delete room cascades files, invites and membership', async () => {
  await alice.delete(`/api/rooms/${roomId}`).set(headers).expect(204);
  await alice.get(`/api/rooms/${roomId}`).expect(404);
  await alice.get(`/api/files/${fileId}`).expect(404);
  assert.equal(
    (await connection.db.select().from(invites).where(eq(invites.roomId, roomId))).length,
    0,
  );
});
