// Fixed loopback endpoints keep the mock executor separate from normal development and E2E.
export const executionFixture = {
  webOrigin: 'http://localhost:3100',
  apiOrigin: 'http://127.0.0.1:4100',
  webPort: 3100,
  apiPort: 4100,
} as const;
