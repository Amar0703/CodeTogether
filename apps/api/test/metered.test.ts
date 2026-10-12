import test from 'node:test';
import assert from 'node:assert/strict';
import { iceEnvironmentSchema } from '../src/ice.js';
import { MeteredPool } from '../src/metered.js';

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
    assert.equal(issued, 16, 'concurrent refill deduplicated');
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
    assert.ok(issued <= 34, 'bounded refill capacity');
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
    assert.throws(() => pool.take(), /warming up/);
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
    assert.throws(() => pool.take(), /warming up/);
    pool.close();
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
