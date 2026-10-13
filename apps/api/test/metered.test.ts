import test from 'node:test';
import assert from 'node:assert/strict';
import { iceEnvironmentSchema } from '../src/ice.js';
import { MeteredPool, MeteredUnavailableError } from '../src/metered.js';

const settings = iceEnvironmentSchema.parse({
  METERED_DOMAIN: 'example.metered.live',
  METERED_SECRET_KEY: 'test-only-metered-management-secret',
  TURN_URLS: 'turn:global.relay.metered.ca:80,turns:global.relay.metered.ca:443?transport=tcp',
  STUN_URLS: 'stun:stun.relay.metered.ca:80',
  ICE_TRANSPORT_POLICY: 'relay',
});
test('Metered settings require a complete, exclusive provider and safe host/lifetime', () => {
  for (const input of [
    { METERED_DOMAIN: 'example.metered.live' },
    { METERED_SECRET_KEY: 'test-only-metered-management-secret' },
    { ...settings, TURN_SHARED_SECRET: 'test-only-coturn-secret-32-characters' },
    { ...settings, METERED_DOMAIN: 'example.metered.live.evil.test' },
    { ...settings, METERED_DOMAIN: 'localhost:1234' },
    { ...settings, TURN_TTL_SECONDS: 300 },
  ]) {
    // Parsed settings contain arrays; feed env strings back into validation.
    assert.equal(
      iceEnvironmentSchema.safeParse({
        ...input,
        TURN_URLS: 'TURN_URLS' in input ? settings.TURN_URLS.join(',') : undefined,
        STUN_URLS: '',
      }).success,
      false,
    );
  }
});
test('Metered prewarms, hands out distinct expiring credentials and overlaps rotation without sharing responses', async () => {
  let now = 0,
    issued = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://example.metered.live');
    assert.equal(url.searchParams.get('secretKey'), settings.METERED_SECRET_KEY);
    assert.equal(init?.redirect, 'error');
    if (init?.method === 'DELETE') return Response.json({ success: true });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.expiryInSeconds, 600);
    assert.match(body.label, /^codetogether-[a-f0-9-]+$/);
    issued++;
    return Response.json({
      username: `user-${issued}`,
      password: `password-${issued}`,
      expiryInSeconds: 600,
    });
  };
  const pool = new MeteredPool(settings, transport, () => now);
  try {
    await Promise.all([pool.refill(), pool.refill()]);
    assert.equal(issued, 4, 'concurrent refill deduplicated');
    assert.throws(() => pool.take(), /warming up/);
    now = 120_000;
    const a = pool.take(),
      b = pool.take();
    assert.notEqual(a.iceServers[1].username, b.iceServers[1].username);
    assert.equal(a.iceTransportPolicy, 'relay');
    assert.equal(a.expiresAt, new Date(600_000).toISOString());
    assert.equal(JSON.stringify(a).includes(settings.METERED_SECRET_KEY!), false);
    await pool.refill();
    now = 240_001;
    await pool.refill();
    now = 360_002;
    assert.doesNotThrow(() => pool.take(), 'older cohort still works while replacements propagate');
    now = 420_001;
    const renewed = pool.take();
    assert.ok(Date.parse(renewed.expiresAt) > now + 180_000);
    await pool.refill();
    assert.ok(issued <= 12, 'bounded refill capacity');
  } finally {
    pool.close();
  }
  assert.throws(() => pool.take(), /unavailable/);
});
test('Metered failures are sanitized, retried with backoff and never silently downgraded to STUN', async () => {
  let now = 0,
    requests = 0;
  const pool = new MeteredPool(
    settings,
    async () => {
      requests++;
      throw new Error(settings.METERED_SECRET_KEY);
    },
    () => now,
  );
  try {
    await pool.refill();
    assert.throws(() => pool.take(), /cannot reach/);
    await pool.refill();
    assert.equal(requests, 1);
    now = 30_000;
    await pool.refill();
    assert.equal(requests, 2);
  } finally {
    pool.close();
  }
});
test('Metered rejects malformed, oversized, quota-denied and overlong-lived credentials', async () => {
  for (const response of [
    Response.json({ error: 'quota exhausted' }, { status: 403 }),
    Response.json({ username: 'u', password: 'p', expiryInSeconds: 3600 }),
    Response.json({ username: 'u', password: 'p' }),
    new Response('x'.repeat(16_385)),
    new Response('not-json'),
  ]) {
    let now = 0;
    const pool = new MeteredPool(
      settings,
      async () => response,
      () => now,
    );
    await pool.refill();
    now = 120_000;
    assert.throws(() => pool.take(), /TURN provider/);
    pool.close();
  }
});

test('Metered distinguishes provider failures from propagation, logs only categories, and recovers', async () => {
  for (const [status, message] of [
    [401, /authentication/],
    [403, /rejected credential/],
    [429, /rate limiting/],
    [500, /temporarily unavailable/],
    [200, /unsupported credential/],
  ] as const) {
    let now = 0,
      recovered = false;
    const reports: unknown[] = [];
    const secret = settings.METERED_SECRET_KEY!;
    const pool = new MeteredPool(
      settings,
      async () =>
        Response.json(
          recovered
            ? { username: 'safe-user', password: 'safe-password', expiryInSeconds: 600 }
            : { message: secret, username: secret },
          { status: recovered ? 200 : status },
        ),
      () => now,
      (reason, httpStatus) => reports.push({ reason, httpStatus }),
    );
    try {
      await pool.refill();
      assert.throws(
        () => pool.take(),
        (error: unknown) =>
          error instanceof MeteredUnavailableError &&
          error.code === 'MEDIA_PROVIDER_UNAVAILABLE' &&
          message.test(error.message),
      );
      now = 30_000;
      await pool.refill();
      assert.equal(reports.length, 1, 'repeated failures do not flood logs');
      assert.equal(JSON.stringify(reports).includes(secret), false);
      recovered = true;
      now = 60_000;
      await pool.refill();
      assert.throws(() => pool.take(), /120 seconds/);
      now += 90_000;
      assert.throws(() => pool.take(), /30 seconds/);
      now += 30_000;
      assert.equal(pool.take().turnConfigured, true);
      assert.equal(reports.length, 2, 'recovery is reported once');
    } finally {
      pool.close();
    }
  }
});
test('Metered shutdown aborts an in-flight request and late responses cannot repopulate the pool', async () => {
  let release!: () => void, signal: AbortSignal | null | undefined;
  const pool = new MeteredPool(settings, async (_url, init) => {
    signal = init?.signal;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return Response.json({ username: 'u', password: 'p', expiryInSeconds: 600 });
  });
  const pending = pool.refill();
  pool.close();
  assert.equal(signal?.aborted, true);
  release();
  await pending;
  assert.throws(() => pool.take(), /unavailable/);
});

test('Metered tolerates slower responses but bounds hung requests and reports timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | null | undefined;
  const reports: string[] = [];
  const pool = new MeteredPool(
    settings,
    (_url, init) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error(settings.METERED_SECRET_KEY)), {
          once: true,
        });
      });
    },
    () => 0,
    (reason) => reports.push(reason),
  );
  try {
    const request = pool.refill();
    t.mock.timers.tick(6000);
    assert.equal(signal?.aborted, false, 'a slow provider is not aborted at five seconds');
    t.mock.timers.tick(9000);
    await request;
    assert.equal(signal?.aborted, true);
    assert.throws(() => pool.take(), /timing out/);
    assert.deepEqual(reports, ['timeout']);
  } finally {
    pool.close();
  }
});

test('four callers renew for an hour within a ten-credential provider limit without revoking assigned credentials', async () => {
  let now = 0,
    issued = 0,
    retired = 0,
    peak = 0;
  const provider = new Map<string, { expiresAt: number; assigned: boolean }>();
  // An unrelated permanent dashboard credential must remain untouched.
  provider.set('manual', { expiresAt: Infinity, assigned: true });
  const transport: typeof fetch = async (_url, init) => {
    for (const [username, value] of provider) if (value.expiresAt <= now) provider.delete(username);
    const body = JSON.parse(String(init?.body));
    if (init?.method === 'DELETE') {
      assert.equal(
        provider.get(body.username)?.assigned,
        false,
        'never delete a credential handed to a caller',
      );
      provider.delete(body.username);
      retired++;
      return Response.json({ success: true });
    }
    assert.ok(provider.size < 10, 'creation must fit the free account limit');
    const username = `generated-${++issued}`;
    provider.set(username, { expiresAt: now + 600_000, assigned: false });
    peak = Math.max(peak, provider.size);
    return Response.json({ username, password: 'test-password', expiryInSeconds: 600 });
  };
  const pool = new MeteredPool(
    settings,
    transport,
    () => now,
    () => {},
  );
  const renewals: number[] = [];
  const assign = () => {
    const config = pool.take();
    provider.get(config.iceServers[1].username!)!.assigned = true;
    return Date.parse(config.expiresAt) - 60_000;
  };
  try {
    await pool.refill();
    now = 120_000;
    for (let caller = 0; caller < 4; caller++) renewals.push(assign());
    for (; now < 3_600_000; now += 30_000) {
      await pool.refill();
      for (let caller = 0; caller < 4; caller++)
        if (now >= renewals[caller]) renewals[caller] = assign();
      await pool.refill();
    }
    assert.ok(retired > 0, 'unused credentials must be retired to free slots');
    assert.ok(issued > 20, 'exercise repeated expiry and renewal');
    assert.ok(peak <= 9, 'at most eight managed credentials plus the unrelated manual one');
    assert.equal(provider.has('manual'), true);
  } finally {
    pool.close();
  }
});

test('a credential being retired cannot be assigned while its deletion is pending', async () => {
  let now = 0,
    issued = 0;
  let deleting: string | undefined, release!: () => void;
  const pool = new MeteredPool(
    settings,
    async (_url, init) => {
      if (init?.method === 'DELETE') {
        deleting = JSON.parse(String(init.body)).username;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return Response.json({ success: true });
      }
      return Response.json({
        username: `u-${++issued}`,
        password: 'password',
        expiryInSeconds: 600,
      });
    },
    () => now,
  );
  try {
    await pool.refill();
    now = 240_001;
    await pool.refill();
    now = 420_001;
    const cleanup = pool.refill();
    assert.ok(deleting);
    const result = pool.take();
    assert.notEqual(result.iceServers[1].username, deleting);
    pool.close(); // Stop before another delete; release the single pending operation.
    release();
    await cleanup;
  } finally {
    pool.close();
  }
});
