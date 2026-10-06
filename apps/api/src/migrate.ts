import { connectDatabase } from '@codetogether/db';
import { config } from './config.js';
const connection = await connectDatabase(config.DATABASE_URL, config.PGLITE_DATA_DIR);
try {
  await connection.migrate();
  console.log('Database migrations applied.');
} finally {
  await connection.close();
}
