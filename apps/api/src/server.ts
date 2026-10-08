import { connectDatabase } from '@codetogether/db';
import { createApp } from './app.js';
import { config } from './config.js';
import { createServer } from 'node:http';
import { Realtime } from './realtime.js';
const connection = await connectDatabase(config.DATABASE_URL, config.PGLITE_DATA_DIR);
if (config.NODE_ENV !== 'production') await connection.migrate();
const realtime = new Realtime(connection.db, config.APP_ORIGIN);
const server = createServer(
  createApp(connection.db, {
    origin: config.APP_ORIGIN,
    production: config.NODE_ENV === 'production',
    realtime,
  }),
);
realtime.attach(server);
server.listen(config.API_PORT, config.API_HOST, () =>
  console.log(
    `CodeTogether API: http://localhost:${config.API_PORT} (${config.DATABASE_URL ? 'PostgreSQL' : 'local persistent PostgreSQL'})`,
  ),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void realtime
      .close()
      .then(() => connection.close())
      .then(() => process.exit(0));
  });
