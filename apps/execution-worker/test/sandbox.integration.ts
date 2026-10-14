import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Docker from 'dockerode';
import { DockerSandbox, sandboxLabel } from '../src/sandbox.js';
import type { ExecutionLanguage, OutputChunk } from '@codetogether/contracts';

// These adversarial fixtures are never executed unless a disposable local Docker host is explicitly selected.
const enabled = process.env.TEST_SANDBOX === 'disposable-local';
if (enabled && (process.env.NODE_ENV === 'production' || process.env.DOCKER_HOST))
  throw new Error('Use a disposable local Docker socket, never production');
const sandbox = new DockerSandbox(
  new Docker({
    socketPath: process.env.TEST_DOCKER_SOCKET ?? '/var/run/docker.sock',
    timeout: 5000,
  }),
  process.env.TEST_SANDBOX_IMAGE ?? 'codetogether-sandbox:local',
  process.env.TEST_SANDBOX_RUNTIME === 'runsc' ? 'runsc' : 'runc',
);
async function run(
  language: ExecutionLanguage,
  source: string,
  stdin = '',
  controller = new AbortController(),
) {
  await sandbox.ready();
  const chunks: OutputChunk[] = [];
  const result = await sandbox.run(
    { executionId: randomUUID(), attempt: randomUUID(), language, source, stdin },
    controller.signal,
    async (chunk) => {
      chunks.push(chunk);
    },
  );
  return { ...result, output: chunks.map((c) => c.text).join(''), chunks };
}
after(async () => {
  if (enabled) await sandbox.close();
});
for (const [language, source] of [
  [
    'javascript',
    "process.stdout.write(require('fs').readFileSync(0,'utf8')); console.error('err')",
  ],
  ['python', "import sys\nprint(sys.stdin.read(),end='')\nprint('err',file=sys.stderr)"],
  [
    'cpp',
    '#include <iostream>\n#include <string>\nint main(){std::string s;std::getline(std::cin,s);std::cout<<s;std::cerr<<"err";}',
  ],
] as const) {
  test(
    `REAL sandbox: ${language} with stdin/stdout/stderr`,
    { skip: !enabled, timeout: 30000 },
    async () => {
      const r = await run(language, source, 'hello');
      assert.equal(r.status, 'SUCCEEDED', JSON.stringify(r));
      assert.equal(
        r.chunks
          .filter((c) => c.stream === 'stdout')
          .map((c) => c.text)
          .join(''),
        'hello',
      );
      assert.equal(
        r.chunks
          .filter((c) => c.stream === 'stderr')
          .map((c) => c.text)
          .join('')
          .trim(),
        'err',
      );
    },
  );
}
test(
  'REAL sandbox: deterministic errors, CPU timeout and output cap',
  { skip: !enabled, timeout: 90000 },
  async () => {
    assert.equal((await run('cpp', 'not valid c++')).failure, 'COMPILE_ERROR');
    assert.equal((await run('python', "raise RuntimeError('boom')")).failure, 'RUNTIME_ERROR');
    const loop = await run('javascript', 'while(true){}');
    assert.ok(['TIMED_OUT', 'FAILED'].includes(loop.status));
    assert.equal(loop.failure, 'RESOURCE_LIMIT');
    const flood = await run('python', "print('x'*200000)");
    assert.ok(flood.truncated);
    assert.ok(Buffer.byteLength(flood.output) <= 65536);
  },
);
test(
  'REAL sandbox: memory, process, network and forbidden filesystem limits',
  { skip: !enabled, timeout: 90000 },
  async () => {
    const memory = await run('python', 'x=[]\nwhile True: x.append(bytearray(10000000))');
    assert.notEqual(memory.status, 'SUCCEEDED');
    const processes = await run(
      'python',
      "import subprocess\na=[]\ntry:\n for i in range(100): a.append(subprocess.Popen(['sleep','10']))\nexcept OSError: print('bounded')",
    );
    assert.ok(processes.output.includes('bounded') || processes.failure === 'RESOURCE_LIMIT');
    const denied = await run(
      'python',
      "import socket,os\nfor p in ['/var/run/docker.sock','/app/.env','/proc/1/root/app/.env','/root/.aws/credentials']:\n assert not os.path.exists(p),p\ntry:\n open('/forbidden','w').write('bad')\n raise AssertionError('writable root')\nexcept OSError: pass\ns=socket.socket();s.settimeout(.3)\ntry:\n s.connect(('169.254.169.254',80))\n raise AssertionError('network available')\nexcept OSError: pass\nprint('denied')",
    );
    assert.equal(denied.status, 'SUCCEEDED');
    assert.ok(denied.output.includes('denied'));
  },
);
test(
  'REAL sandbox: cancellation removes containers and descendants',
  { skip: !enabled, timeout: 30000 },
  async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    const result = await run('python', 'import time\ntime.sleep(100)', '', controller);
    clearTimeout(timer);
    assert.equal(result.status, 'CANCELLED');
    await sandbox.reap();
    assert.equal(
      (
        await sandbox.docker.listContainers({
          all: true,
          filters: JSON.stringify({ label: [`${sandboxLabel}=v1`] }),
        })
      ).length,
      0,
    );
  },
);

test(
  'REAL sandbox: independent janitor cleans up after trusted worker SIGKILL',
  { skip: !enabled, timeout: 35000 },
  async () => {
    // Only trusted TypeScript infrastructure runs on the host. The Python fixture runs in Docker.
    const janitor = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('../src/janitor.ts', import.meta.url))],
      {
        env: {
          ...process.env,
          DOCKER_SOCKET: process.env.TEST_DOCKER_SOCKET ?? '/var/run/docker.sock',
        },
        stdio: 'ignore',
      },
    );
    const worker = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./orphan-fixture.ts', import.meta.url))],
      { stdio: 'ignore' },
    );
    const list = () =>
      sandbox.docker.listContainers({
        all: true,
        filters: JSON.stringify({ label: [`${sandboxLabel}=v1`] }),
      });
    try {
      const until = Date.now() + 10000;
      let running = false;
      while (Date.now() < until) {
        if ((await list()).some((c) => c.State === 'running')) {
          running = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(running, 'fixture must have started a real sandbox');
      worker.kill('SIGKILL');
      const deadline = Date.now() + 21000;
      while ((await list()).length && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(
        (await list()).length,
        0,
        'janitor removes sandbox without worker finally handlers',
      );
    } finally {
      worker.kill('SIGKILL');
      janitor.kill('SIGKILL');
      await sandbox.reap(true);
    }
  },
);
