import Docker from 'dockerode';
import { writeFile } from 'node:fs/promises';
import { DockerSandbox } from './sandbox.js';
const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
  timeout: 5000,
});
const sandbox = new DockerSandbox(docker, '', 'runsc');
// Independent of the worker lifecycle: expired sandbox containers are force-removed,
// even when a worker is SIGKILLed. Run under the host service supervisor.
for (;;) {
  await sandbox
    .reap()
    .then(() => writeFile('/tmp/ct-janitor-alive', String(Date.now())))
    .catch(() => console.warn('Sandbox cleanup unavailable'));
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
