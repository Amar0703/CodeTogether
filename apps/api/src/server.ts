import { connectDatabase } from '@codetogether/db';
import { createApp } from './app.js';
import { config, iceSettings } from './config.js';
import { createServer } from 'node:http';
import { Realtime } from './realtime.js';
import { ExecutionCoordinator } from './execution-queue.js';
import { ExecutionService } from './executions.js';
const connection = await connectDatabase(config.DATABASE_URL, config.PGLITE_DATA_DIR);
if (config.NODE_ENV !== 'production') await connection.migrate();
const realtime = new Realtime(connection.db, config.APP_ORIGIN, { iceSettings });
const execution =
  config.EXECUTION_ENABLED === 'true'
    ? new ExecutionCoordinator(connection.db, config.REDIS_URL!, (e) =>
        realtime.publishExecution(e),
      )
    : undefined;
execution?.start();
const executionService =
  execution?.service ??
  new ExecutionService(connection.db, undefined, (e) => realtime.publishExecution(e));
let reconciling = false;
const reconciliation = !execution
  ? setInterval(() => {
      if (reconciling) return;
      reconciling = true;
      void executionService
        .reconcile()
        .catch(() => {})
        .finally(() => {
          reconciling = false;
        });
    }, 2000)
  : undefined;
reconciliation?.unref();
const server = createServer(
  createApp(connection.db, {
    origin: config.APP_ORIGIN,
    production: config.NODE_ENV === 'production',
    realtime,
    executions: executionService,
    workerToken: execution ? config.EXECUTION_WORKER_TOKEN : undefined,
    trustedProxies: config.TRUSTED_PROXY_CIDRS,
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
    clearInterval(reconciliation);
    void Promise.resolve(execution?.close()).then(() =>
      realtime
        .close()
        .then(() => connection.close())
        .then(() => process.exit(0)),
    );
  });
