import { defineConfig, devices } from '@playwright/test';
import { executionFixture } from './tests/execution-fixture-config.js';
export default defineConfig({
  testDir: './tests',
  testMatch: 'execution.spec.ts',
  workers: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  use: { baseURL: executionFixture.webOrigin, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node --import tsx apps/api/test/browser-execution-server.ts',
      url: `${executionFixture.apiOrigin}/api/health`,
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: `node ../../node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port ${executionFixture.webPort}`,
      cwd: './apps/web',
      env: {
        API_URL: executionFixture.apiOrigin,
        NEXT_PUBLIC_REALTIME_URL: executionFixture.apiOrigin,
      },
      url: `${executionFixture.webOrigin}/api/health`,
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
});
