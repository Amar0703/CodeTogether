import 'dotenv/config';
import { z } from 'zod';
import { normalizeOrigin } from './origin.js';
import { iceEnvironmentSchema } from './ice.js';
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_ORIGIN: z.url().default('http://localhost:3000').transform(normalizeOrigin),
  DATABASE_URL: z.url().optional(),
  PGLITE_DATA_DIR: z.string().default('../../.data/postgres'),
  EXECUTION_ENABLED: z.enum(['true', 'false']).default('false'),
  REDIS_URL: z.url().optional(),
  EXECUTION_WORKER_TOKEN: z.string().min(48).optional(),
  TRUSTED_PROXY_CIDRS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
    )
    .refine(
      (items) => items.every((s) => /^[0-9a-fA-F:./]+$/.test(s)),
      'Use verified proxy IPs/CIDRs only',
    ),
});
export const config = schema.parse(process.env);
export const iceSettings = iceEnvironmentSchema.parse(process.env);
if (config.EXECUTION_ENABLED === 'true' && (!config.REDIS_URL || !config.EXECUTION_WORKER_TOKEN))
  throw new Error('Execution requires REDIS_URL and EXECUTION_WORKER_TOKEN');
if (
  config.NODE_ENV === 'production' &&
  config.EXECUTION_ENABLED === 'true' &&
  !config.REDIS_URL?.startsWith('rediss://')
)
  throw new Error('Production execution requires TLS Redis');
if (
  config.NODE_ENV === 'production' &&
  (!config.DATABASE_URL || !config.APP_ORIGIN.startsWith('https://'))
)
  throw new Error('Production requires DATABASE_URL and an HTTPS APP_ORIGIN');
