import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

declare global {
  interface Window {
    mediaProbe: {
      pcs: RTCPeerConnection[];
      tracks: MediaStreamTrack[];
      requests: number;
      collisions: number;
      restarts: number;
      blockPlayback?: boolean;
      error?: string;
      delay?: number;
      forceCollision?: boolean;
    };
    mediaOfferReady: () => Promise<void>;
  }
}
test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});
async function instrument(context: BrowserContext) {
  await context.addInitScript(() => {
    window.mediaProbe = { pcs: [], tracks: [], requests: 0, collisions: 0, restarts: 0 };
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      constructor(config?: RTCConfiguration) {
        super(config);
        window.mediaProbe.pcs.push(this);
      }
      async setRemoteDescription(description: RTCSessionDescriptionInit) {
        if (description.type === 'offer' && this.signalingState === 'have-local-offer')
          window.mediaProbe.collisions++;
        return super.setRemoteDescription(description);
      }
      async setLocalDescription(description?: RTCLocalSessionDescriptionInit) {
        await super.setLocalDescription(description);
        if (window.mediaProbe.forceCollision && this.localDescription?.type === 'offer') {
          window.mediaProbe.forceCollision = false;
          await window.mediaOfferReady();
        }
      }
      restartIce() {
        window.mediaProbe.restarts++;
        return super.restartIce();
      }
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (window.mediaProbe.blockPlayback)
        return Promise.reject(new DOMException('Playback needs a user action', 'NotAllowedError'));
      return play.call(this);
    };
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      window.mediaProbe.requests++;
      if (window.mediaProbe.error)
        throw new DOMException('Simulated device error', window.mediaProbe.error);
      const stream = await gum(constraints);
      window.mediaProbe.tracks.push(...stream.getTracks());
      if (window.mediaProbe.delay) await new Promise((r) => setTimeout(r, window.mediaProbe.delay));
      return stream;
    };
  });
}
async function pair(browser: Browser) {
  const a = await browser.newContext({ permissions: ['microphone', 'camera'] }),
    b = await browser.newContext({ permissions: ['microphone', 'camera'] });
  await instrument(a);
  await instrument(b);
  const headers = { 'X-CodeTogether': '1', Origin: 'http://localhost:3000' };
  const users: { id: string }[] = [];
  for (const [context, name] of [
    [a, 'Alice Caller'],
    [b, 'Bob Caller'],
  ] as const) {
    const response = await context.request.post('/api/auth/signup', {
      headers,
      data: {
        name,
        email: `${crypto.randomUUID()}@example.com`,
        password: 'media acceptance password',
      },
    });
    expect(response.status()).toBe(201);
    users.push((await response.json()).user);
  }
  const response = await a.request.post('/api/rooms', {
    headers,
    data: { name: 'Media acceptance' },
  });
  const roomId: string = (await response.json()).room.id;
  const invite = await a.request.post(`/api/rooms/${roomId}/invites`, {
    headers,
    data: { role: 'EDITOR' },
  });
  const token = (await invite.json()).url.split('/').at(-1);
  expect((await b.request.post(`/api/invites/${token}/join`, { headers })).ok()).toBe(true);
  const owner = await a.newPage(),
    member = await b.newPage();
  await Promise.all([owner.goto(`/rooms/${roomId}`), member.goto(`/rooms/${roomId}`)]);
  for (const page of [owner, member]) {
    await expect(page.getByRole('button', { name: 'Join call', exact: true })).toBeEnabled();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  }
  return { a, b, owner, member, roomId, users, headers };
}
async function received(page: Page, video = true) {
  try {
    await expect(page.getByTestId('remote-media')).toHaveAttribute('data-state', 'Connected');
  } catch (error) {
    // Capture only states/counts, never SDP, credentials or candidate addresses.
    const states = await page.evaluate(async () =>
      Promise.all(
        window.mediaProbe.pcs.map(async (pc) => {
          const stats = await pc.getStats();
          const rows = [...stats.values()];
          return {
            connection: pc.connectionState,
            signaling: pc.signalingState,
            ice: pc.iceConnectionState,
            gathering: pc.iceGatheringState,
            local: pc.localDescription?.type,
            remote: pc.remoteDescription?.type,
            localCandidates: rows.filter((s) => s.type === 'local-candidate').length,
            remoteCandidates: rows.filter((s) => s.type === 'remote-candidate').length,
            pairs: rows.filter((s) => s.type === 'candidate-pair').map((s) => s.state),
          };
        }),
      ),
    );
    await test
      .info()
      .attach('peer-states', { body: JSON.stringify(states), contentType: 'application/json' });
    throw error;
  }
  await expect
    .poll(() =>
      page.evaluate(async (wantVideo) => {
        const pcs = window.mediaProbe.pcs.filter((pc) => pc.connectionState === 'connected');
        if (!pcs.length) return false;
        const stats = await pcs[pcs.length - 1].getStats();
        const rows = [...stats.values()].filter((s) => s.type === 'inbound-rtp');
        const tracks = pcs[pcs.length - 1].getReceivers().map((r) => r.track);
        return (
          rows.some((s) => s.kind === 'audio' && s.bytesReceived > 100 && s.packetsReceived > 0) &&
          tracks.some((t) => t.kind === 'audio' && t.readyState === 'live') &&
          (!wantVideo ||
            rows.some((s) => s.kind === 'video' && s.framesDecoded > 0 && s.bytesReceived > 100))
        );
      }, video),
    )
    .toBe(true);
}
async function cleaned(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.mediaProbe.tracks.every((t) => t.readyState === 'ended') &&
          window.mediaProbe.pcs.every((pc) => pc.connectionState === 'closed'),
      ),
    )
    .toBe(true);
}
async function inbound(page: Page, kind: 'audio' | 'video') {
  return page.evaluate(async (mediaKind) => {
    const pc = window.mediaProbe.pcs.findLast((p) => p.connectionState === 'connected');
    if (!pc) return 0;
    const stats = await pc.getStats();
    return [...stats.values()]
      .filter((s) => s.type === 'inbound-rtp' && s.kind === mediaKind)
      .reduce(
        (sum, s) => sum + (mediaKind === 'video' ? (s.framesDecoded ?? 0) : (s.bytesReceived ?? 0)),
        0,
      );
  }, kind);
}

async function composerFits(page: Page) {
  const send = page.getByRole('button', { name: 'Send', exact: true });
  // Visibility alone misses controls clipped by an overflow:hidden ancestor.
  const bounds = await send.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return {
      fits: rect.top >= 0 && rect.bottom <= innerHeight && !!hit && element.contains(hit),
      viewport: `${innerWidth}x${innerHeight}`,
      bottom: rect.bottom,
      hit: hit?.tagName,
    };
  });
  if (!bounds.fits) await page.screenshot({ path: 'test-results/chat-layout-failed.png' });
  expect(bounds.fits, JSON.stringify(bounds)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('chat composer stays reachable in short workspaces even when TURN join fails', async ({
  browser,
}) => {
  const f = await pair(browser);
  try {
    await f.owner.route('**/api/rooms/*/ice', (route) =>
      route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'MEDIA_PROVIDER_UNAVAILABLE',
            message: 'TURN provider is unavailable. Check backend diagnostics.',
          },
        },
      }),
    );
    await f.owner.getByRole('button', { name: 'Join call', exact: true }).click();
    await expect(f.owner.getByTestId('call-status')).toHaveText('Failed');
    await cleaned(f.owner);
    for (const viewport of [
      { width: 1536, height: 730 }, // 1920px desktop at 125% scale with browser chrome
      { width: 1280, height: 600 },
      { width: 390, height: 700 },
    ]) {
      await f.owner.setViewportSize(viewport);
      await composerFits(f.owner);
      const message = `Visible composer ${viewport.width}`;
      await f.owner.getByLabel('Message your room').fill(message);
      await f.owner.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(f.member.getByRole('log')).toContainText(message);
      await f.owner.screenshot({ path: `test-results/chat-layout-${viewport.width}.png` });
    }
    // Landscape/virtual-keyboard-sized windows may scroll the sidebar, but never clip controls.
    await f.owner.setViewportSize({ width: 640, height: 360 });
    await f.owner.getByLabel('Message your room').fill('Short viewport chat');
    await f.owner.getByRole('button', { name: 'Send', exact: true }).scrollIntoViewIfNeeded();
    await composerFits(f.owner);
    await f.owner.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(f.member.getByRole('log')).toContainText('Short viewport chat');
  } finally {
    await f.a.close();
    await f.b.close();
  }
});
test('simultaneous media joins receive audio/video, controls, collaboration, viewer safety, reconnect and leave cleanup', async ({
  browser,
}) => {
  test.setTimeout(180_000); // This scenario includes multiple device acquisitions and two reconnects.
  const f = await pair(browser);
  const { owner, member } = f;
  try {
    // Hold the first offers until both browsers have a local offer. This makes
    // rollback coverage deterministic instead of relying on scheduler timing.
    let offers = 0,
      release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const context of [f.a, f.b])
      await context.exposeBinding('mediaOfferReady', () => {
        if (++offers === 2) release();
        return barrier;
      });
    for (const page of [owner, member])
      await page.evaluate(() => {
        window.mediaProbe.forceCollision = true;
      });
    expect(await owner.evaluate(() => window.mediaProbe.requests)).toBe(0);
    expect(await member.evaluate(() => window.mediaProbe.requests)).toBe(0);
    await owner.getByLabel('Join with camera').check();
    await member.getByLabel('Join with camera').check();
    await Promise.all([
      owner.getByRole('button', { name: 'Join call', exact: true }).click(),
      member.getByRole('button', { name: 'Join call', exact: true }).click(),
    ]);
    await received(owner);
    await received(member);
    // Both peers create sendrecv transceivers, so initial simultaneous offers exercise rollback.
    await expect
      .poll(
        async () =>
          (await owner.evaluate(() => window.mediaProbe.collisions)) +
          (await member.evaluate(() => window.mediaProbe.collisions)),
      )
      .toBeGreaterThan(0);
    await expect(owner.getByTestId('local-media').locator('video')).toHaveJSProperty('muted', true);
    await owner.locator('.cm-content').fill('CALL_EDIT\n');
    await expect(member.locator('.cm-content')).toContainText('CALL_EDIT');
    await member.locator('.cm-content').click();
    await member.keyboard.press('Control+End');
    await member.keyboard.insertText('PEER_EDIT');
    await expect(owner.locator('.cm-content')).toContainText('PEER_EDIT');
    await member.getByLabel('Message your room').fill('Chat during video');
    await member.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(owner.getByRole('log')).toContainText('Chat during video');
    expect(
      (
        await f.a.request.patch(`/api/rooms/${f.roomId}/members/${f.users[1].id}`, {
          headers: f.headers,
          data: { role: 'VIEWER' },
        })
      ).ok(),
    ).toBe(true);
    await expect(member.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await member.locator('.cm-content').click();
    await member.keyboard.press('Control+z');
    await member.locator('.cm-content').evaluate((element) =>
      element.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'historyUndo',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await expect(member.locator('.cm-content')).toContainText('PEER_EDIT');
    await received(member);
    await member.getByRole('button', { name: 'Mute microphone', exact: true }).click();
    await expect(owner.getByTestId('remote-media')).toContainText('Muted');
    await expect
      .poll(() =>
        member.evaluate(() =>
          window.mediaProbe.tracks
            .filter((t) => t.kind === 'audio')
            .every((t) => t.readyState === 'ended'),
        ),
      )
      .toBe(true);
    await member.getByRole('button', { name: 'Turn camera off', exact: true }).click();
    await expect(owner.getByTestId('remote-media')).toContainText('Camera off');
    const audioBefore = await inbound(owner, 'audio'),
      videoBefore = await inbound(owner, 'video');
    await member.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
    await member.getByRole('button', { name: 'Turn camera on', exact: true }).click();
    await received(owner);
    await expect.poll(() => inbound(owner, 'audio')).toBeGreaterThan(audioBefore);
    await expect.poll(() => inbound(owner, 'video')).toBeGreaterThan(videoBefore);
    // Choose a concrete device rather than the default; fake-device availability is browser-owned.
    const option = member.getByLabel('Camera device').locator('option').nth(1);
    const id = await option.getAttribute('value');
    if (id) await member.getByLabel('Camera device').selectOption(id);
    await owner.setViewportSize({ width: 1440, height: 1000 });
    await composerFits(owner);
    await owner.screenshot({ path: 'test-results/call-desktop.png', fullPage: true });
    await owner.setViewportSize({ width: 390, height: 844 });
    await composerFits(owner);
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await owner.screenshot({ path: 'test-results/call-mobile.png', fullPage: true });
    await owner.getByRole('button', { name: 'Toggle members', exact: true }).click();
    await expect(owner.locator('.cm-content')).toBeVisible();
    await owner.screenshot({ path: 'test-results/call-mobile-editor.png', fullPage: true });
    await owner.getByRole('button', { name: 'Toggle members', exact: true }).click();
    await owner.setViewportSize({ width: 1440, height: 1000 });
    const requests = await member.evaluate(() => window.mediaProbe.requests);
    await f.b.setOffline(true);
    await expect(member.getByTestId('call-status')).toHaveText('Reconnecting');
    await f.b.setOffline(false);
    await received(owner);
    await received(member);
    expect(await member.evaluate(() => window.mediaProbe.requests)).toBe(requests);
    await member.getByRole('button', { name: 'Leave call', exact: true }).click();
    await cleaned(member);
    await expect(owner.getByTestId('remote-media')).toHaveCount(0);
    await f.b.setOffline(true);
    await f.b.setOffline(false);
    await expect(member.getByRole('button', { name: 'Join call', exact: true })).toBeEnabled();
    expect(await member.evaluate(() => window.mediaProbe.requests)).toBe(requests);
    await member.getByLabel('Join with camera').uncheck();
    await member.getByRole('button', { name: 'Join call', exact: true }).click();
    await received(owner, false);
    await received(member);
    expect(
      (
        await f.a.request.delete(`/api/rooms/${f.roomId}/members/${f.users[1].id}`, {
          headers: f.headers,
        })
      ).status(),
    ).toBe(204);
    await cleaned(member);
    await expect(owner.getByTestId('remote-media')).toHaveCount(0);
    await owner.getByRole('button', { name: 'Leave call', exact: true }).click();
    await cleaned(owner);
  } finally {
    await f.a.close();
    await f.b.close();
  }
});

test('device errors, device removal and leaving during pending permission do not leak tracks or autojoin', async ({
  browser,
}) => {
  const f = await pair(browser);
  const page = f.owner;
  try {
    for (const error of ['NotAllowedError', 'NotFoundError', 'NotReadableError']) {
      await page.evaluate((name) => {
        window.mediaProbe.error = name;
      }, error);
      await page.getByRole('button', { name: 'Join call', exact: true }).click();
      await expect(page.getByTestId('call-status')).toHaveText('Failed');
      await expect(page.locator('.call-error')).toBeVisible();
      await cleaned(page);
    }
    await page.evaluate(() => {
      window.mediaProbe.error = undefined;
      window.mediaProbe.delay = 1500;
    });
    await page.getByRole('button', { name: 'Join call', exact: true }).click();
    await page.getByRole('button', { name: 'Leave call', exact: true }).click();
    await cleaned(page);
    await expect(page.getByTestId('call-status')).toHaveText('Not in call');
    await page.evaluate(() => {
      window.mediaProbe.delay = undefined;
    });
    await page.getByRole('button', { name: 'Join call', exact: true }).click();
    await expect(page.getByTestId('call-status')).toHaveText('Connected');
    await page.evaluate(() => {
      const track = window.mediaProbe.tracks.find((t) => t.readyState === 'live');
      track?.stop();
      track?.dispatchEvent(new Event('ended'));
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    });
    await expect(
      page.getByRole('button', { name: 'Unmute microphone', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.call-error')).toContainText('disconnected');
    await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
    await page.getByRole('button', { name: 'Back to rooms', exact: true }).click();
    await cleaned(page);
  } finally {
    await f.a.close();
    await f.b.close();
  }
});

test('credential refresh restarts ICE without reacquiring devices and blocked playback has a user action', async ({
  browser,
}) => {
  const f = await pair(browser);
  let issued = 0;
  try {
    await f.owner.route('**/api/rooms/*/ice', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      issued++;
      await route.fulfill({
        response,
        json: {
          ...data,
          expiresAt: new Date(Date.now() + (issued === 1 ? 65_000 : 600_000)).toISOString(),
        },
      });
    });
    await f.owner.evaluate(() => {
      window.mediaProbe.blockPlayback = true;
    });
    for (const page of [f.owner, f.member])
      await page.getByRole('button', { name: 'Join call', exact: true }).click();
    await received(f.owner, false);
    await received(f.member, false);
    await expect(
      f.owner.getByRole('button', { name: 'Enable audio playback', exact: true }).first(),
    ).toBeVisible();
    await f.owner.evaluate(() => {
      window.mediaProbe.blockPlayback = false;
    });
    // Scope to stable tiles: each successful click removes its playback button.
    for (const tile of await f.owner.locator('.call-tile').all()) {
      const button = tile.getByRole('button', { name: 'Enable audio playback', exact: true });
      if (await button.count()) await button.click();
    }
    await expect(
      f.owner.getByRole('button', { name: 'Enable audio playback', exact: true }),
    ).toHaveCount(0);
    await expect(f.owner.getByTestId('remote-media').locator('audio')).toHaveJSProperty(
      'paused',
      false,
    );
    const playbackTime = await f.owner
      .getByTestId('remote-media')
      .locator('audio')
      .evaluate((element) => (element as HTMLAudioElement).currentTime);
    await expect
      .poll(() =>
        f.owner
          .getByTestId('remote-media')
          .locator('audio')
          .evaluate((element) => (element as HTMLAudioElement).currentTime),
      )
      .toBeGreaterThan(playbackTime);
    await expect.poll(() => issued).toBeGreaterThan(1);
    await expect.poll(() => f.owner.evaluate(() => window.mediaProbe.restarts)).toBeGreaterThan(0);
    expect(await f.owner.evaluate(() => window.mediaProbe.requests)).toBe(1);
    const before = await inbound(f.owner, 'audio');
    await expect.poll(() => inbound(f.owner, 'audio')).toBeGreaterThan(before);
    await f.a.request.post('/api/auth/logout', { headers: f.headers });
    await cleaned(f.owner);
    await expect(f.member.getByTestId('remote-media')).toHaveCount(0);
  } finally {
    await f.a.close();
    await f.b.close();
  }
});

test('forced TURN relay receives real media packets', async ({ browser }) => {
  test.setTimeout(240_000);
  test.skip(
    process.env.TEST_TURN_RELAY !== '1',
    'Requires usable TURN credentials and API ICE_TRANSPORT_POLICY=relay.',
  );
  const f = await pair(browser);
  try {
    // Metered prewarms credentials off the call path after API startup.
    // Poll infrequently to stay below the authenticated issuance rate limit.
    await expect
      .poll(
        async () => {
          const response = await f.a.request.post(`/api/rooms/${f.roomId}/ice`, {
            headers: f.headers,
          });
          if (response.ok()) {
            const config = await response.json();
            expect(config.turnConfigured).toBe(true);
            expect(config.iceTransportPolicy).toBe('relay');
          }
          return response.status();
        },
        { timeout: 180_000, intervals: [15_000] },
      )
      .toBe(200);
    for (const page of [f.owner, f.member]) {
      await page.getByLabel('Join with camera').check();
      await page.getByRole('button', { name: 'Join call', exact: true }).click();
    }
    await received(f.owner);
    await received(f.member);
    for (const page of [f.owner, f.member])
      expect(
        await page.evaluate(async () => {
          const pc = window.mediaProbe.pcs.find((p) => p.connectionState === 'connected')!;
          const stats = await pc.getStats();
          const pair = [...stats.values()].find(
            (s) => s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated,
          );
          return (
            pc.getConfiguration().iceTransportPolicy === 'relay' &&
            stats.get(pair.localCandidateId)?.candidateType === 'relay'
          );
        }),
      ).toBe(true);
  } finally {
    await f.a.close();
    await f.b.close();
  }
});
