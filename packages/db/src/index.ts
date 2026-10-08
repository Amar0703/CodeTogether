import { PGlite } from '@electric-sql/pglite';
import { drizzle as localDrizzle } from 'drizzle-orm/pglite';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';
export * from './schema.js';
export type Database = NodePgDatabase<typeof schema>;

export async function connectDatabase(url?: string, directory?: string) {
  // Numbered migrations are ordered and idempotent; each records its applied version.
  const directoryUrl = new URL('../migrations/', import.meta.url);
  const migrations = await Promise.all(
    (await readdir(directoryUrl))
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .sort()
      .map((name) => readFile(fileURLToPath(new URL(name, directoryUrl)), 'utf8')),
  );
  if (url) {
    const pool = new Pool({ connectionString: url, max: 10 });
    return {
      db: drizzle(pool, { schema }),
      migrate: async () => {
        const client = await pool.connect();
        try {
          for (const migration of migrations) await client.query(migration);
        } finally {
          client.release();
        }
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
      for (const migration of migrations) await client.exec(migration);
    },
    close: () => client.close(),
  };
}
