import { defineConfig } from '@playwright/test';

/** The port the built site is served on for the browser tests. */
const PORT = 4174;

/**
 * Browser tests of the built PWA (`pnpm run test:e2e`): runs in a real Chromium against site-dist/.
 */
export default defineConfig({
  testDir: './site/e2e',
  testMatch: '**/*.browser.ts',
  fullyParallel: true,
  use: {
    baseURL: `http://localhost:${String(PORT)}/`,
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  webServer: {
    command: 'tsx site/e2e/serve.ts',
    url: `http://localhost:${String(PORT)}/`,
    env: { PORT: String(PORT) },
    reuseExistingServer: false,
  },
});
