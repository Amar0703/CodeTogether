import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: 'execution.spec.ts',
  workers: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx apps/api/test/browser-execution-server.ts',
      url: 'http://localhost:4000/api/health',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'npm run dev --workspace=@codetogether/web',
      url: 'http://localhost:3000',
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
});
