import { test, expect, type Browser, type Page } from '@playwright/test';
import { executionFixture } from './execution-fixture-config.js';
test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      // Local coexistence fixture: avoid Windows mDNS ICE discovery. Production browser flags are unchanged.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  },
});
async function pair(browser: Browser) {
  const a = await browser.newContext({ permissions: ['camera', 'microphone'] }),
    b = await browser.newContext({ permissions: ['camera', 'microphone'] });
  for (const context of [a, b])
    await context.addInitScript(() => {
      const native = window.RTCPeerConnection;
      const peers: RTCPeerConnection[] = [];
      const events: unknown[] = [];
      Object.assign(window, { executionPeers: peers, executionEvents: events });
      const log = (event: unknown) => {
        if (events.length < 256) events.push(event);
      };
      window.RTCPeerConnection = class extends native {
        constructor(c?: RTCConfiguration) {
          super(c);
          peers.push(this);
          this.addEventListener('icegatheringstatechange', () =>
            log({ op: 'gathering', state: this.iceGatheringState }),
          );
          this.addEventListener('icecandidate', (event) =>
            log({
              op: 'gathered',
              candidate: !!event.candidate,
              fragment: !!event.candidate?.usernameFragment,
            }),
          );
        }
        async setLocalDescription(description?: RTCLocalSessionDescriptionInit) {
          try {
            await super.setLocalDescription(description);
            log({ op: 'local', type: this.localDescription?.type, state: this.signalingState });
          } catch (error) {
            log({ op: 'local-error', error: String(error) });
            throw error;
          }
        }
        async setRemoteDescription(description: RTCSessionDescriptionInit) {
          try {
            await super.setRemoteDescription(description);
            log({ op: 'remote', type: description.type, state: this.signalingState });
          } catch (error) {
            log({ op: 'remote-error', error: String(error) });
            throw error;
          }
        }
        async addIceCandidate(candidate?: RTCIceCandidateInit | null) {
          try {
            await super.addIceCandidate(candidate);
            log({ op: 'candidate' });
          } catch (error) {
            log({ op: 'candidate-error', error: String(error) });
            throw error;
          }
        }
      };
    });
  const headers = { 'X-CodeTogether': '1', Origin: executionFixture.webOrigin };
  const identities = [];
  for (const [context, name] of [
    [a, 'Run Owner'],
    [b, 'Run Observer'],
  ] as const) {
    const r = await context.request.post('/api/auth/signup', {
      headers,
      data: { name, email: `${crypto.randomUUID()}@example.com`, password: 'execution password' },
    });
    expect(r.status()).toBe(201);
    identities.push((await r.json()).user.id);
  }
  const created = await a.request.post('/api/rooms', {
    headers,
    data: { name: 'Execution browser acceptance' },
  });
  const roomId = (await created.json()).room.id;
  const invitation = await a.request.post(`/api/rooms/${roomId}/invites`, {
    headers,
    data: { role: 'VIEWER' },
  });
  const token = (await invitation.json()).url.split('/').at(-1);
  await b.request.post(`/api/invites/${token}/join`, { headers });
  const owner = await a.newPage(),
    viewer = await b.newPage();
  await Promise.all([owner.goto(`/rooms/${roomId}`), viewer.goto(`/rooms/${roomId}`)]);
  for (const page of [owner, viewer]) {
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Run code & execution history/ }).click();
  }
  return { a, b, owner, viewer, roomId, headers, identities };
}
async function audioBytes(page: Page) {
  return page.evaluate(async () => {
    const peers = (window as unknown as { executionPeers: RTCPeerConnection[] }).executionPeers;
    let bytes = 0;
    for (const pc of peers)
      for (const report of (await pc.getStats()).values())
        if (report.type === 'inbound-rtp' && report.kind === 'audio')
          bytes += report.bytesReceived ?? 0;
    return bytes;
  });
}
async function joinParticipants(owner: Page, viewer: Page) {
  // This suite checks coexistence; the dedicated media suite tests simultaneous negotiation.
  for (const page of [owner, viewer]) {
    await page.getByRole('button', { name: 'Join call', exact: true }).click();
    await expect(page.getByTestId('call-status')).toHaveText('Connected');
  }
}
async function joinCall(owner: Page, viewer: Page) {
  await joinParticipants(owner, viewer);
  for (const page of [owner, viewer]) {
    try {
      // Allow the existing bounded ICE recovery (15-second cycles) before testing coexistence.
      await expect(page.getByTestId('remote-media')).toHaveAttribute('data-state', 'Connected', {
        timeout: 45000,
      });
    } catch (error) {
      const states = await Promise.all(
        [owner, viewer].map((p) =>
          p.evaluate(async () =>
            Promise.all(
              (window as unknown as { executionPeers: RTCPeerConnection[] }).executionPeers.map(
                async (pc) => {
                  const stats = [...(await pc.getStats()).values()];
                  return {
                    connection: pc.connectionState,
                    signaling: pc.signalingState,
                    ice: pc.iceConnectionState,
                    local: pc.localDescription?.type,
                    remote: pc.remoteDescription?.type,
                    localCandidates: stats.filter((s) => s.type === 'local-candidate').length,
                    remoteCandidates: stats.filter((s) => s.type === 'remote-candidate').length,
                    pairs: stats.filter((s) => s.type === 'candidate-pair').map((s) => s.state),
                  };
                },
              ),
            ),
          ),
        ),
      );
      await test.info().attach('execution-call-states', {
        body: JSON.stringify(states),
        contentType: 'application/json',
      });
      await test.info().attach('execution-call-operations', {
        body: JSON.stringify(
          await Promise.all(
            [owner, viewer].map((p) =>
              p.evaluate(
                () => (window as unknown as { executionEvents: unknown[] }).executionEvents,
              ),
            ),
          ),
        ),
        contentType: 'application/json',
      });
      throw error;
    }
    await expect.poll(() => audioBytes(page)).toBeGreaterThan(0);
  }
}
test('MOCK execution: two authenticated contexts receive output, viewer observes, chat/edit coexist and reload recovers', async ({
  browser,
}) => {
  const { a, b, owner, viewer, roomId, headers } = await pair(browser);
  try {
    await expect(viewer.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
    await owner.locator('.cm-content').fill('console.log("snapshot one");');
    await expect(owner.getByText('Saved', { exact: true })).toBeVisible();
    await owner.getByLabel('Execution stdin').fill('input');
    await owner.getByRole('button', { name: 'Run', exact: true }).click();
    for (const page of [owner, viewer])
      await expect(page.getByLabel('Execution output')).toContainText('MOCK sandbox output');
    await expect(owner.getByTestId('execution-result')).toContainText('RUNNING');
    await owner.locator('.cm-content').fill('console.log("newer edits");');
    await expect(viewer.locator('.cm-content')).toContainText('newer edits');
    const composer = owner.getByRole('textbox', { name: 'Message your room' });
    await composer.fill('chat while execution runs');
    await owner.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(viewer.getByText('chat while execution runs', { exact: true })).toBeVisible();
    await expect(viewer.getByTestId('execution-result')).toContainText('SUCCEEDED');
    expect(
      await viewer.evaluate(() => (window as unknown as { pwned?: boolean }).pwned),
    ).toBeUndefined();
    const page = await a.request.get(`/api/rooms/${roomId}/executions`);
    const run = (await page.json()).executions[0];
    const detail = await a.request.get(`/api/rooms/${roomId}`);
    const file = (await detail.json()).files[0];
    expect(run.version).toBeLessThan(file.version);
    expect(
      (
        await b.request.post(`/api/rooms/${roomId}/executions`, {
          headers,
          data: {
            fileId: file.id,
            idempotencyKey: crypto.randomUUID(),
            language: 'javascript',
            sourceHash: run.sourceHash,
            version: run.version,
            stdin: '',
          },
        })
      ).status(),
    ).toBe(403);
    await viewer.reload();
    await viewer.getByRole('button', { name: /Run code & execution history/ }).click();
    await expect(viewer.getByLabel('Execution output')).toContainText('MOCK stderr');
    await expect(viewer.getByTestId('execution-result')).toContainText('SUCCEEDED');
  } finally {
    await a.close();
    await b.close();
  }
});
test('MOCK execution panel preserves chat composer/call controls in desktop, mobile and short windows; cancellation is visible', async ({
  browser,
}) => {
  const { a, b, owner, viewer } = await pair(browser);
  try {
    await joinParticipants(owner, viewer);
    await owner.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(owner.getByRole('button', { name: 'Cancel run' })).toBeVisible();
    await owner.getByRole('button', { name: 'Cancel run' }).click();
    await expect(owner.getByTestId('execution-result')).toContainText('CANCELLED');
    await expect(viewer.getByTestId('execution-result')).toContainText('CANCELLED');
    for (const [width, height] of [
      [1536, 730],
      [1280, 600],
      [390, 700],
      [640, 360],
    ]) {
      await owner.setViewportSize({ width, height });
      const members = owner.getByRole('button', { name: 'Toggle members' });
      if (!(await owner.locator('.people-panel').isVisible())) await members.click();
      const leave = owner.getByRole('button', { name: 'Leave call', exact: true });
      await leave.scrollIntoViewIfNeeded();
      await expect(leave).toBeVisible();
      const leaveBox = await leave.boundingBox();
      expect(leaveBox!.y + leaveBox!.height).toBeLessThanOrEqual(height + 1);
      const composer = owner.getByRole('textbox', { name: 'Message your room' });
      await composer.scrollIntoViewIfNeeded();
      await composer.fill(`layout ${width}`);
      await owner.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(viewer.getByText(`layout ${width}`, { exact: true })).toBeVisible();
      const box = await composer.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);
      await owner.screenshot({ path: `test-results/execution-${width}x${height}.png` });
      if (width < 1000) {
        await members.click();
        const editor = owner.locator('.editor-surface');
        await editor.scrollIntoViewIfNeeded();
        const editorBox = await editor.boundingBox();
        expect(editorBox!.height).toBeGreaterThanOrEqual(112);
        await owner.screenshot({ path: `test-results/execution-editable-${width}x${height}.png` });
        await owner.getByTestId('execution-result').scrollIntoViewIfNeeded();
        expect(
          (await owner.locator('.execution-panel').boundingBox())!.height,
        ).toBeGreaterThanOrEqual(144);
        await owner.screenshot({ path: `test-results/execution-editor-${width}x${height}.png` });
      }
    }
  } finally {
    await a.close();
    await b.close();
  }
});

test('MOCK execution: real fake-device audio RTP continues during a run', async ({ browser }) => {
  const { a, b, owner, viewer } = await pair(browser);
  try {
    await joinCall(owner, viewer);
    const before = await Promise.all([audioBytes(owner), audioBytes(viewer)]);
    await owner.getByRole('button', { name: 'Run', exact: true }).click();
    for (const [index, page] of [owner, viewer].entries()) {
      await expect(page.getByTestId('execution-result')).toContainText('RUNNING');
      await expect(page.getByLabel('Execution output')).toContainText('MOCK sandbox output');
      await expect.poll(() => audioBytes(page)).toBeGreaterThan(before[index]);
    }
    await expect(viewer.getByTestId('execution-result')).toContainText('SUCCEEDED');
  } finally {
    await a.close();
    await b.close();
  }
});
