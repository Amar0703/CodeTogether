import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { connectDatabase, users, rooms, messages, files } from '@codetogether/db';
import { DocumentStore } from '../src/documents.js';
import * as Y from 'yjs';

test('local database creates nested directories and survives a connection restart', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'codetogether-test-'));
  const directory = join(temporaryRoot, 'nested', 'database');
  let connection = await connectDatabase(undefined, directory);
  try {
    await connection.migrate();
    const userId = randomUUID(),
      roomId = randomUUID(),
      messageId = randomUUID();
    const fileId = randomUUID();
    await connection.db.insert(users).values({
      id: userId,
      name: 'Persistent user',
      email: 'persist@example.com',
      passwordHash: 'test-only-hash',
    });
    await connection.db
      .insert(rooms)
      .values({ id: roomId, ownerId: userId, name: 'Persistent chat' });
    await connection.db.insert(files).values({
      id: fileId,
      roomId,
      name: 'persist.ts',
      path: '/persist.ts',
      kind: 'FILE',
      content: 'Legacy content',
    });
    const documentStore = new DocumentStore(connection.db);
    const initial = await documentStore.sync(roomId, fileId, {}, async () => 'OWNER');
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(initial.update, 'base64'));
    doc.getText('content').insert(0, 'Durable edit ');
    await documentStore.sync(
      roomId,
      fileId,
      { update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') },
      async () => 'OWNER',
    );
    const expected = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
    doc.destroy();
    await connection.db.insert(messages).values({
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
    const recovered = await new DocumentStore(connection.db).sync(
      roomId,
      fileId,
      {},
      async () => 'OWNER',
    );
    assert.equal(
      recovered.update,
      expected,
      'CRDT identifiers survive database close, reopen and migration replay',
    );
    const storedFiles = await connection.db.select().from(files);
    assert.equal(storedFiles[0].content, 'Durable edit Legacy content');
  } finally {
    await connection.close();
    const resolved = resolve(temporaryRoot);
    assert.ok(
      resolved.startsWith(resolve(tmpdir()) + sep) && resolved.includes('codetogether-test-'),
    );
    await rm(resolved, { recursive: true, force: true });
  }
});
