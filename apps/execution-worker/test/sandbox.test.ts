import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import type Docker from 'dockerode';
import { containerOptions, DockerSandbox, splitOutput, fitBytes } from '../src/sandbox.js';
import { executionLimits, executionResultSchema } from '@codetogether/contracts';
test('sandbox configuration has no infrastructure secrets, mounts, networks or privileges', () => {
  const options = containerOptions('approved@sha256:abc', 'runsc', 'fixed-id');
  assert.equal(options.User, '65534:65534');
  assert.equal(options.NetworkDisabled, true);
  assert.equal(options.HostConfig?.Runtime, 'runsc');
  assert.equal(options.HostConfig?.ReadonlyRootfs, true);
  assert.equal(options.HostConfig?.NetworkMode, 'none');
  assert.equal(options.HostConfig?.Privileged, false);
  assert.deepEqual(options.HostConfig?.CapDrop, ['ALL']);
  assert.deepEqual(options.HostConfig?.SecurityOpt, ['no-new-privileges:true']);
  assert.equal(options.HostConfig?.Memory, executionLimits.memoryBytes);
  assert.equal(options.HostConfig?.MemorySwap, executionLimits.memoryBytes);
  assert.equal(options.HostConfig?.PidsLimit, 32);
  assert.equal(options.HostConfig?.NanoCpus, 1_000_000_000);
  assert.equal(options.HostConfig?.Binds, undefined);
  assert.equal(options.HostConfig?.Devices, undefined);
  assert.equal(options.HostConfig?.Privileged, false);
  assert.ok(!JSON.stringify(options).includes('REDIS'));
  assert.ok(!JSON.stringify(options).includes('TOKEN'));
  assert.equal(options.HostConfig?.LogConfig?.Type, 'none');
  const workMount = options.HostConfig?.Tmpfs?.['/work']?.split(',') ?? [];
  assert.ok(workMount.includes('exec'), 'compiled C++ must run inside the bounded workspace');
  assert.ok(workMount.includes('size=32m'));
  assert.ok(workMount.includes('nosuid') && workMount.includes('nodev'));
  assert.ok(options.HostConfig?.Tmpfs?.['/tmp']?.split(',').includes('noexec'));
});
test('UTF-8 output chunks stay within byte limits without splitting Unicode', () => {
  const text = '😀héllo'.repeat(5000);
  const chunks = splitOutput(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every((c) => Buffer.byteLength(c) <= 4096));
  assert.equal(fitBytes('😀x', 3), '');
  assert.equal(fitBytes('😀x', 4), '😀');
  assert.equal(executionResultSchema.safeParse({ status: 'QUEUED' }).success, false);
});

// Model Docker control-plane timing only. These tests never execute submitted code.
function cancellationFixture(remove: () => Promise<void>) {
  const controller = new AbortController();
  const stream = Object.assign(new PassThrough(), { setTimeout: () => {} });
  const container = {
    id: 'cancelled-container',
    attach: async () => stream,
    start: async () => {},
    inspect: async () => {
      controller.abort();
      return { State: { Running: true } };
    },
    remove,
  };
  const docker = {
    createContainer: async () => container,
    modem: { demuxStream: () => {} },
  } as unknown as Docker;
  const sandbox = new DockerSandbox(docker, 'test-image', 'runsc');
  return {
    sandbox,
    stream,
    run: () =>
      sandbox.run(
        {
          executionId: 'test-id',
          attempt: 'test-attempt',
          language: 'python',
          source: '',
          stdin: '',
        },
        controller.signal,
        async () => {},
      ),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('cancellation and shutdown await the same pending Docker removal', async (t) => {
  const started = deferred();
  const removed = deferred();
  let calls = 0;
  const fixture = cancellationFixture(async () => {
    calls++;
    if (calls > 1) throw { statusCode: 409 };
    started.resolve();
    await removed.promise;
  });
  t.after(() => {
    removed.resolve();
    fixture.stream.destroy();
  });
  let runFinished = false;
  const run = fixture.run().then((result) => {
    runFinished = true;
    return result;
  });
  await started.promise;
  let closed = false;
  const close = fixture.sandbox.close().then(() => {
    closed = true;
  });
  await setImmediate();
  assert.equal(runFinished, false, 'cancellation must not finish before Docker removal');
  assert.equal(closed, false, 'shutdown must not finish before Docker removal');
  assert.equal(calls, 1, 'abort, finally and shutdown share one removal request');
  removed.resolve();
  assert.equal((await run).status, 'CANCELLED');
  await close;
});

test('a concurrent janitor removal conflict is awaited until Docker confirms absence', async (t) => {
  let calls = 0;
  const fixture = cancellationFixture(async () => {
    calls++;
    throw { statusCode: calls < 3 ? 409 : 404 };
  });
  t.after(() => fixture.stream.destroy());
  assert.equal((await fixture.run()).status, 'CANCELLED');
  assert.equal(calls, 3, 'a conflict alone does not confirm removal');
});

test('unconfirmed cleanup fails instead of returning a completed execution result', async (t) => {
  let available = false;
  let removed = false;
  const fixture = cancellationFixture(async () => {
    if (!available) throw { statusCode: 500 };
    removed = true;
  });
  t.after(() => fixture.stream.destroy());
  await assert.rejects(fixture.run(), /Sandbox cleanup unavailable/);
  available = true;
  await fixture.sandbox.close();
  assert.equal(removed, true, 'failed cleanup remains tracked for shutdown');
});

test('a persistent Docker removal conflict exhausts a bounded cleanup deadline', async (t) => {
  let now = 0;
  let calls = 0;
  t.mock.method(Date, 'now', () => now);
  const fixture = cancellationFixture(async () => {
    calls++;
    now += 2000;
    throw { statusCode: 409 };
  });
  t.after(() => fixture.stream.destroy());
  await assert.rejects(fixture.run(), /Sandbox cleanup unavailable/);
  assert.equal(calls, 3, 'persistent conflicts cannot keep cleanup waiting indefinitely');
});
