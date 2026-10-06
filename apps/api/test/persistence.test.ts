import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { connectDatabase, users } from '@codetogether/db';

test('local database creates nested directories and survives a connection restart', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'codetogether-test-'));
  const directory = join(temporaryRoot, 'nested', 'database');
  let connection = await connectDatabase(undefined, directory);
  try {
    await connection.migrate();
    await connection.db
      .insert(users)
      .values({
        id: randomUUID(),
        name: 'Persistent user',
        email: 'persist@example.com',
        passwordHash: 'test-only-hash',
      });
    await connection.close();
    connection = await connectDatabase(undefined, directory);
    await connection.migrate();
    const saved = await connection.db.select().from(users);
    assert.equal(saved[0].name, 'Persistent user');
  } finally {
    await connection.close();
    const resolved = resolve(temporaryRoot);
    assert.ok(
      resolved.startsWith(resolve(tmpdir()) + sep) && resolved.includes('codetogether-test-'),
    );
    await rm(resolved, { recursive: true, force: true });
  }
});
