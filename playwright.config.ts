import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testIgnore: 'execution.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Own both server process groups directly: Turbo/watch can leave detached API children alive.
  webServer: [
    {
      command: 'node --import tsx src/server.ts',
      cwd: './apps/api',
      url: 'http://localhost:4000/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'node ../../node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3000',
      cwd: './apps/web',
      url: 'http://localhost:3000/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
