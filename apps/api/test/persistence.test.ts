import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { connectDatabase, users, rooms, messages } from '@codetogether/db';

test('local database creates nested directories and survives a connection restart', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'codetogether-test-'));
  const directory = join(temporaryRoot, 'nested', 'database');
  let connection = await connectDatabase(undefined, directory);
  try {
    await connection.migrate();
    const userId = randomUUID(),
      roomId = randomUUID(),
      messageId = randomUUID();
    await connection.db.insert(users).values({
      id: userId,
      name: 'Persistent user',
      email: 'persist@example.com',
      passwordHash: 'test-only-hash',
    });
    await connection.db
      .insert(rooms)
      .values({ id: roomId, ownerId: userId, name: 'Persistent chat' });
    await connection.db
      .insert(messages)
      .values({
        id: messageId,
        roomId,
        userId,
        senderName: 'Persistent user',
        clientMessageId: randomUUID(),
        body: 'Survives a database restart',
      });
    await connection.close();
    connection = await connectDatabase(undefined, directory);
    await connection.migrate();
    const saved = await connection.db.select().from(users);
    assert.equal(saved[0].name, 'Persistent user');
    const chat = await connection.db.select().from(messages);
    assert.equal(chat[0].id, messageId);
    assert.equal(chat[0].body, 'Survives a database restart');
  } finally {
    await connection.close();
    const resolved = resolve(temporaryRoot);
    assert.ok(
      resolved.startsWith(resolve(tmpdir()) + sep) && resolved.includes('codetogether-test-'),
    );
    await rm(resolved, { recursive: true, force: true });
  }
});
