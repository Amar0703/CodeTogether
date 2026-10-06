import { test, expect } from '@playwright/test';
test('two accounts share persistent files and a viewer cannot edit', async ({ browser }) => {
  const ownerContext = await browser.newContext(),
    memberContext = await browser.newContext();
  const owner = await ownerContext.newPage(),
    member = await memberContext.newPage();
  const suffix = Date.now();
  for (const [page, name] of [
    [owner, 'Alex Builder'],
    [member, 'Sam Reader'],
  ] as const) {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Create an account', exact: true }).click();
    await page.getByLabel('Your name').fill(name);
    await page.getByLabel('Email address').fill(`${name.split(' ')[0]}-${suffix}@example.com`);
    await page.getByLabel('Password', { exact: true }).fill('a strong demo password');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByRole('heading', { name: `Hey, ${name.split(' ')[0]}.` })).toBeVisible();
  }
  await owner.getByRole('button', { name: 'Create a room', exact: true }).click();
  await owner.getByLabel('Room name').fill('Two-person MVP');
  await owner.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect(owner.locator('.cm-content')).toBeVisible();
  await owner.locator('.cm-content').fill('const persisted = "Hello from Alex";');
  await owner.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(owner.getByText('Saved', { exact: true })).toBeVisible();
  await owner.getByRole('button', { name: 'Invite', exact: true }).click();
  await owner.getByLabel('Access level').selectOption('VIEWER');
  await owner.getByRole('button', { name: 'Generate invitation' }).click();
  const invite = await owner.getByLabel('Invitation link').inputValue();
  await owner.getByRole('button', { name: 'Close dialog' }).click();
  await member.goto(invite);
  await member.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(member.locator('.cm-content')).toContainText('Hello from Alex');
  await expect(member.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await expect(member.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await owner.reload();
  await expect(owner.locator('.cm-content')).toContainText('Hello from Alex');
  await owner.getByRole('button', { name: 'New folder', exact: true }).click();
  await owner.getByLabel('Name', { exact: true }).fill('src');
  await owner.getByRole('button', { name: 'Create', exact: true }).click();
  await owner.getByRole('button', { name: 'New file', exact: true }).click();
  await owner.getByLabel('Name', { exact: true }).fill('helper.py');
  await owner.getByRole('button', { name: 'Create', exact: true }).click();
  await owner.locator('.cm-content').fill('print("saved too")');
  await owner.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(owner.getByText('Saved', { exact: true })).toBeVisible();
  await member.getByRole('button', { name: 'Refresh files', exact: true }).click();
  await member.getByRole('button', { name: 'helper.py', exact: true }).click();
  await expect(member.locator('.cm-content')).toContainText('saved too');
  await owner.getByRole('button', { name: 'Rename selected', exact: true }).click();
  await owner.getByLabel('Name', { exact: true }).fill('utils.py');
  await owner.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(owner.getByRole('button', { name: 'utils.py', exact: true })).toBeVisible();
  await expect(owner.getByRole('button', { name: 'src', exact: true })).toBeVisible();
  await owner.screenshot({ path: 'test-results/workspace.png', fullPage: true });
  const roomUrl = owner.url();
  await owner.getByRole('button', { name: 'Back to rooms', exact: true }).click();
  await expect(owner.getByRole('heading', { name: 'Two-person MVP' })).toBeVisible();
  await owner.screenshot({ path: 'test-results/dashboard.png', fullPage: true });
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(owner.getByRole('button', { name: 'Create a room', exact: true })).toBeVisible();
  expect(
    await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await owner.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  await owner.goto(roomUrl);
  await owner.getByRole('button', { name: 'Hide members', exact: true }).click();
  await expect(owner.locator('.cm-content')).toBeVisible();
  expect(
    await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await owner.screenshot({ path: 'test-results/workspace-mobile.png', fullPage: true });
  await owner.goto('/login');
  await owner.screenshot({ path: 'test-results/login-mobile.png', fullPage: true });
  await ownerContext.close();
  await memberContext.close();
});
