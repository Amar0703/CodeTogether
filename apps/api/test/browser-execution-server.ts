// Explicit browser-test fixture. No submitted code is evaluated or launched.
// This entry point is never imported by the production API or worker.
import { createServer } from 'node:http';
import { eq } from 'drizzle-orm';
import { connectDatabase, executions } from '@codetogether/db';
import { createApp } from '../src/app.js';
import { ExecutionService } from '../src/executions.js';
import { Realtime } from '../src/realtime.js';
if (process.env.NODE_ENV === 'production') throw new Error('Test fixture prohibited in production');
const connection = await connectDatabase();
await connection.migrate();
const realtime = new Realtime(connection.db, 'http://localhost:3000');
const service = new ExecutionService(
  connection.db,
  async () => true,
  (e) => realtime.publishExecution(e),
);
const app = createApp(connection.db, {
  origin: 'http://localhost:3000',
  realtime,
  executions: service,
  rateLimit: 1000,
});
const server = createServer(app);
realtime.attach(server);
server.listen(4000, '127.0.0.1');
let busy = false;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const [row] = await connection.db
      .select()
      .from(executions)
      .where(eq(executions.status, 'QUEUED'))
      .limit(1);
    if (!row) return;
    await pause(1500);
    const claim = await service.claim(row.id);
    if (!claim) return;
    await service.update(row.id, claim.attempt, {
      sequence: 1,
      stream: 'stdout',
      text: 'MOCK sandbox output <script>window.pwned=true</script>\n',
    });
    await pause(9000);
    await service.update(row.id, claim.attempt, {
      sequence: 2,
      stream: 'stderr',
      text: 'MOCK stderr\n',
    });
    await service.update(row.id, claim.attempt, undefined, {
      status: 'SUCCEEDED',
      failure: null,
      exitCode: 0,
      durationMs: 9000,
      truncated: false,
    });
  } catch {
    /* Revocation/cancellation can end the deterministic fixture. */
  } finally {
    busy = false;
  }
}, 250);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    clearInterval(timer);
    void realtime
      .close()
      .then(() => connection.close())
      .then(() => process.exit(0));
  });
