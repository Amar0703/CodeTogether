import { connectDatabase } from '@codetogether/db';
import { createApp } from './app.js';
import { config } from './config.js';
const connection = await connectDatabase(config.DATABASE_URL, config.PGLITE_DATA_DIR);
if (config.NODE_ENV !== 'production') await connection.migrate();
const server = createApp(connection.db, {
  origin: config.APP_ORIGIN,
  production: config.NODE_ENV === 'production',
}).listen(config.API_PORT, config.API_HOST, () =>
  console.log(
    `CodeTogether API: http://localhost:${config.API_PORT} (${config.DATABASE_URL ? 'PostgreSQL' : 'local persistent PostgreSQL'})`,
  ),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close(() => {
      void connection.close().then(() => process.exit(0));
    });
  });
