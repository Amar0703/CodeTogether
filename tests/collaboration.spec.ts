import { test, expect, type Browser, type Page } from '@playwright/test';

async function pair(browser: Browser) {
  const ownerContext = await browser.newContext(),
    memberContext = await browser.newContext();
  const owner = await ownerContext.newPage(),
    member = await memberContext.newPage();
  const headers = { 'X-CodeTogether': '1', Origin: 'http://localhost:3000' };
  const users = [];
  for (const [context, name] of [
    [ownerContext, 'Alice Author'],
    [memberContext, 'Bob Builder'],
  ] as const) {
    const response = await context.request.post('http://localhost:3000/api/auth/signup', {
      headers,
      data: {
        name,
        email: `${crypto.randomUUID()}@example.com`,
        password: 'collaboration password',
      },
    });
    expect(response.status()).toBe(201);
    users.push((await response.json()).user);
  }
  const response = await ownerContext.request.post('http://localhost:3000/api/rooms', {
    headers,
    data: { name: 'Collaboration acceptance' },
  });
  const roomId = (await response.json()).room.id;
  const invitation = await ownerContext.request.post(
    `http://localhost:3000/api/rooms/${roomId}/invites`,
    { headers, data: { role: 'EDITOR' } },
  );
  const token = (await invitation.json()).url.split('/').at(-1);
  expect(
    (
      await memberContext.request.post(`http://localhost:3000/api/invites/${token}/join`, {
        headers,
      })
    ).ok(),
  ).toBe(true);
  await Promise.all([owner.goto(`/rooms/${roomId}`), member.goto(`/rooms/${roomId}`)]);
  await expect(owner.locator('.cm-content')).toBeVisible();
  await expect(member.locator('.cm-content')).toBeVisible();
  await expect(owner.getByText('Saved', { exact: true })).toBeVisible();
  await expect(member.getByText('Saved', { exact: true })).toBeVisible();
  return { owner, member, ownerContext, memberContext, roomId, users, headers };
}
async function append(page: Page, text: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(text);
}
async function converged(a: Page, b: Page) {
  const text = (page: Page) =>
    page.locator('.cm-line').evaluateAll((lines) =>
      lines
        .map((line) => {
          const copy = line.cloneNode(true) as HTMLElement;
          copy.querySelectorAll('.cm-ySelectionCaret').forEach((cursor) => cursor.remove());
          return copy.textContent;
        })
        .join('\n'),
    );
  await expect.poll(async () => (await text(a)) === (await text(b))).toBe(true);
  await expect(a.getByText('Saved', { exact: true })).toBeVisible();
  await expect(b.getByText('Saved', { exact: true })).toBeVisible();
}
test('simultaneous edits converge, selections appear, local undo preserves peer work, files stay isolated', async ({
  browser,
}) => {
  const { owner, member, ownerContext, memberContext } = await pair(browser);
  try {
    await owner.locator('.cm-content').fill('base\n');
    await converged(owner, member);
    await Promise.all([append(owner, 'ALICE'), append(member, 'BOB')]);
    await converged(owner, member);
    await expect(owner.locator('.cm-content')).toContainText('ALICE');
    await expect(member.locator('.cm-content')).toContainText('BOB');
    await owner.keyboard.press('Control+z');
    await converged(owner, member);
    await expect(owner.locator('.cm-content')).toContainText('BOB');
    await expect(owner.locator('.cm-content')).not.toContainText('ALICE');
    await owner.keyboard.press('Control+y');
    await converged(owner, member);
    await expect(member.locator('.cm-content')).toContainText('ALICE');
    await member.locator('.cm-content').click();
    await member.keyboard.press('Control+End');
    await member.keyboard.press('Shift+Home');
    await expect(owner.locator('.cm-ySelection')).not.toHaveCount(0);
    await expect(
      owner.locator('.cm-ySelectionInfo').filter({ hasText: 'Bob Builder' }),
    ).toBeVisible();
    await owner.setViewportSize({ width: 1440, height: 1000 });
    await owner.screenshot({ path: 'test-results/collaboration-desktop.png', fullPage: true });
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await owner.screenshot({ path: 'test-results/collaboration-mobile.png', fullPage: true });
    await owner.setViewportSize({ width: 1440, height: 1000 });
    await member.getByRole('button', { name: 'New file', exact: true }).click();
    await member.getByLabel('Name', { exact: true }).fill('isolated.py');
    await member.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(member.locator('.file-tab')).toContainText('isolated.py');
    await expect(member.getByText('Saved', { exact: true })).toBeVisible();
    await expect(owner.locator('.cm-ySelectionInfo')).toHaveCount(0);
    await member.locator('.cm-content').fill('print("separate")');
    await expect(member.getByText('Saved', { exact: true })).toBeVisible();
    await expect(owner.locator('.cm-content')).not.toContainText('separate');
    await member.getByRole('button', { name: 'main.js', exact: true }).click();
    await converged(owner, member);
    await member.keyboard.press('Control+z');
    await expect(member.locator('.cm-content')).toContainText('ALICE');
    owner.on('dialog', (dialog) => dialog.accept());
    await owner.getByRole('button', { name: 'Delete selected' }).click();
    await expect(
      member.getByText('This file was deleted from the room.', { exact: false }),
    ).toBeVisible();
    await expect(member.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await expect(
      member.getByRole('button', { name: 'Download your draft', exact: true }),
    ).toBeVisible();
  } finally {
    await ownerContext.close();
    await memberContext.close();
  }
});

test('offline edits merge once after reload; offline revocation retains exportable work without replay', async ({
  browser,
}) => {
  const { owner, member, ownerContext, memberContext, roomId, users, headers } =
    await pair(browser);
  try {
    await owner.locator('.cm-content').fill('start\n');
    await converged(owner, member);
    await memberContext.setOffline(true);
    await expect(member.getByText('Offline', { exact: true }).first()).toBeVisible();
    await member.locator('.cm-content').fill('OFFLINE_WORK');
    await append(owner, 'ONLINE_WORK');
    // Wait for the local IDB transaction, then reload before the reconnect replay can run.
    const localBeforeReload = await member.evaluate(async () => {
      const databases = await indexedDB.databases();
      const name = databases.find((db) => db.name?.startsWith('codetogether-v3:'))?.name;
      if (!name) return 0;
      return new Promise<number>((resolve) => {
        const open = indexedDB.open(name);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('document');
          const read = tx.objectStore('document').get('state');
          read.onsuccess = () => {
            resolve(read.result?.byteLength ?? 0);
            db.close();
          };
        };
      });
    });
    expect(localBeforeReload).toBeGreaterThan(0);
    member.on('dialog', (dialog) => dialog.accept());
    await memberContext.setOffline(false);
    await member.reload();
    await converged(owner, member);
    await expect(owner.locator('.cm-content')).toContainText('OFFLINE_WORK');
    await expect(member.locator('.cm-content')).toContainText('ONLINE_WORK');
    await expect(member.locator('.cm-content')).not.toContainText('start');
    expect((await owner.locator('.cm-content').innerText()).split('OFFLINE_WORK')).toHaveLength(2);
    await memberContext.setOffline(true);
    await expect(member.getByText('Offline', { exact: true }).first()).toBeVisible();
    await append(member, 'REVOKED_DRAFT');
    expect(
      (
        await ownerContext.request.delete(
          `http://localhost:3000/api/rooms/${roomId}/members/${users[1].id}`,
          { headers },
        )
      ).status(),
    ).toBe(204);
    await memberContext.setOffline(false);
    await expect(member.getByText('Access removed', { exact: true })).toBeVisible();
    await expect(member.locator('.cm-content')).toContainText('REVOKED_DRAFT');
    await expect(owner.locator('.cm-content')).not.toContainText('REVOKED_DRAFT');
    await member.reload();
    await member.getByRole('button', { name: 'Recover local drafts', exact: true }).click();
    const download = member.waitForEvent('download');
    await member.getByRole('button', { name: /^Download recovered/ }).click();
    const artifact = await download;
    const stream = await artifact.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toContain('REVOKED_DRAFT');
  } finally {
    await ownerContext.close();
    await memberContext.close();
  }
});
