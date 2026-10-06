import { PGlite } from '@electric-sql/pglite';
import { drizzle as localDrizzle } from 'drizzle-orm/pglite';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';
export * from './schema.js';
export type Database = NodePgDatabase<typeof schema>;

export async function connectDatabase(url?: string, directory?: string) {
  const migration = await readFile(
    fileURLToPath(new URL('../migrations/0001_core.sql', import.meta.url)),
    'utf8',
  );
  if (url) {
    const pool = new Pool({ connectionString: url, max: 10 });
    return {
      db: drizzle(pool, { schema }),
      migrate: async () => {
        await pool.query(migration);
      },
      close: () => pool.end(),
    };
  }
  if (directory) await mkdir(directory, { recursive: true });
  const client = new PGlite(directory);
  await client.waitReady;
  // Both drivers implement the same PostgreSQL queries used by this package.
  return {
    db: localDrizzle(client, { schema }) as unknown as Database,
    migrate: async () => {
      await client.exec(migration);
    },
    close: () => client.close(),
  };
}
