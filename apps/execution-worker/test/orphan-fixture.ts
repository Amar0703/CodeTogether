// Trusted test harness. Submitted source is passed ONLY to the isolated Docker adapter.
import Docker from 'dockerode';
import { randomUUID } from 'node:crypto';
import { DockerSandbox } from '../src/sandbox.js';
if (
  process.env.TEST_SANDBOX !== 'disposable-local' ||
  process.env.NODE_ENV === 'production' ||
  process.env.DOCKER_HOST
)
  throw new Error('Disposable local sandbox test only');
const sandbox = new DockerSandbox(
  new Docker({
    socketPath: process.env.TEST_DOCKER_SOCKET ?? '/var/run/docker.sock',
    timeout: 5000,
  }),
  process.env.TEST_SANDBOX_IMAGE ?? 'codetogether-sandbox:local',
  process.env.TEST_SANDBOX_RUNTIME === 'runsc' ? 'runsc' : 'runc',
);
await sandbox.run(
  {
    executionId: randomUUID(),
    attempt: randomUUID(),
    language: 'python',
    source: 'import subprocess,time\nsubprocess.Popen(["sleep","100"])\ntime.sleep(100)',
    stdin: '',
  },
  new AbortController().signal,
  async () => {},
);
