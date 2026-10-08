import { test, expect, type Page } from '@playwright/test';

test('two browser contexts receive presence, chat, room events and reconnect catchup without refresh', async ({
  browser,
}) => {
  const ownerContext = await browser.newContext(),
    memberContext = await browser.newContext();
  const owner = await ownerContext.newPage(),
    member = await memberContext.newPage();
  const suffix = Date.now();
  const signup = async (page: Page, name: string) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Create an account', exact: true }).click();
    await page.getByLabel('Your name').fill(name);
    await page.getByLabel('Email address').fill(`${name.split(' ')[0]}-${suffix}@example.com`);
    await page.getByLabel('Password', { exact: true }).fill('a strong demo password');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByRole('heading', { name: `Hey, ${name.split(' ')[0]}.` })).toBeVisible();
  };
  try {
    await signup(owner, 'Riya Builder');
    await signup(member, 'Dev Partner');
    await owner.getByRole('button', { name: 'Create a room', exact: true }).click();
    await owner.getByLabel('Room name').fill('Realtime workshop');
    await owner.getByRole('button', { name: 'Create room', exact: true }).click();
    await expect(owner.getByText('Connected', { exact: true })).toBeVisible();
    await owner.getByRole('button', { name: 'Invite', exact: true }).click();
    await owner.getByRole('button', { name: 'Generate invitation' }).click();
    const invitation = await owner.getByLabel('Invitation link').inputValue();
    await owner.getByRole('button', { name: 'Close dialog' }).click();
    await member.goto(invitation);
    await member.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(member.getByText('Connected', { exact: true })).toBeVisible();
    await expect(owner.getByTestId('online-count')).toHaveText('2 online now');
    await expect(member.getByTestId('online-count')).toHaveText('2 online now');
    await owner.getByLabel('Message your room').fill('Ready to work through the solution?');
    await owner.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(member.getByRole('log')).toContainText('Ready to work through the solution?');
    await member.getByLabel('Message your room').fill('Yes! I will start with the edge cases.');
    await member.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(owner.getByRole('log')).toContainText('Yes! I will start with the edge cases.');
    const tab = await memberContext.newPage();
    await tab.goto(member.url());
    await expect(tab.getByText('Connected', { exact: true })).toBeVisible();
    await tab.close();
    await expect(owner.getByTestId('online-count')).toHaveText('2 online now');

    // Room events update the tree, but neither saved content nor new roles discard a draft.
    await member.locator('.cm-content').fill('const myDraft = "keep this";');
    await owner.locator('.cm-content').fill('const shared = "new saved version";');
    await owner.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      member.getByText('A newer saved version is available.', { exact: false }),
    ).toBeVisible();
    await expect(member.locator('.cm-content')).toContainText('keep this');
    await member.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(member.locator('.error-banner')).toContainText('changed since');
    await expect(member.locator('.cm-content')).toContainText('keep this');
    await owner.getByRole('button', { name: 'New file', exact: true }).click();
    await owner.getByLabel('Name', { exact: true }).fill('notes.md');
    await owner.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(member.getByRole('button', { name: 'notes.md', exact: true })).toBeVisible();

    await memberContext.setOffline(true);
    await expect(member.getByText('Offline', { exact: true }).first()).toBeVisible();
    await member.getByLabel('Message your room').fill('Retry this once I am back');
    await member.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(member.getByText('Failed to send', { exact: true })).toBeVisible();
    await owner.getByLabel('Message your room').fill('Saved while you were offline');
    await owner.getByRole('button', { name: 'Send', exact: true }).click();
    // A live message must not advance the recovery cursor past a failed history page.
    let interruptedRecovery = false;
    await member.route('**/api/rooms/*/messages?after=*', async (route) => {
      if (interruptedRecovery) {
        await route.continue();
        return;
      }
      interruptedRecovery = true;
      await owner.getByLabel('Message your room').fill('Arrived during recovery');
      await owner.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(member.getByRole('log')).toContainText('Arrived during recovery');
      await route.abort('failed');
    });
    await memberContext.setOffline(false);
    await expect(member.getByText('Connected', { exact: true })).toBeVisible();
    expect(interruptedRecovery).toBe(true);
    await expect(member.getByRole('log')).toContainText('Saved while you were offline');
    await expect(member.locator('.cm-content')).toContainText('keep this');
    await member.getByRole('button', { name: 'Retry message', exact: true }).click();
    await expect(
      owner.getByRole('log').getByText('Retry this once I am back', { exact: true }),
    ).toHaveCount(1);
    await expect(member.getByText('Failed to send', { exact: true })).toHaveCount(0);
    await owner.getByLabel('Role for Dev Partner').selectOption('VIEWER');
    await expect(member.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await expect(member.locator('.cm-content')).toContainText('keep this');
    await expect(member.getByRole('button', { name: 'Download your draft' })).toBeVisible();

    await owner.setViewportSize({ width: 1440, height: 1000 });
    await owner.screenshot({ path: 'test-results/realtime-desktop.png', fullPage: true });
    await owner.setViewportSize({ width: 390, height: 844 });
    await owner.getByLabel('Message your room').scrollIntoViewIfNeeded();
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await owner.screenshot({ path: 'test-results/realtime-mobile.png', fullPage: true });
    await owner.getByLabel('Message your room').fill('Sent from the mobile layout');
    await owner.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(member.getByRole('log')).toContainText('Sent from the mobile layout');
    await owner.setViewportSize({ width: 1440, height: 1000 });
    owner.on('dialog', (dialog) => dialog.accept());
    await owner.getByRole('button', { name: 'Remove Dev Partner' }).click();
    await expect(member.getByText('Access removed', { exact: true })).toBeVisible();
    await expect(member.locator('.cm-content')).toContainText('keep this');
    await expect(owner.getByTestId('online-count')).toHaveText('1 online now');
  } finally {
    await ownerContext.close();
    await memberContext.close();
  }
});
