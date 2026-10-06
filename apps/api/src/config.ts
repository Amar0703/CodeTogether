import 'dotenv/config';
import { z } from 'zod';
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_ORIGIN: z.url().default('http://localhost:3000'),
  DATABASE_URL: z.url().optional(),
  PGLITE_DATA_DIR: z.string().default('../../.data/postgres'),
});
export const config = schema.parse(process.env);
if (
  config.NODE_ENV === 'production' &&
  (!config.DATABASE_URL || !config.APP_ORIGIN.startsWith('https://'))
)
  throw new Error('Production requires DATABASE_URL and an HTTPS APP_ORIGIN');
