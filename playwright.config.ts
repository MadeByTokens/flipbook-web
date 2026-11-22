import { defineConfig } from '@playwright/test';

// CSS-pixel viewport of an 11-inch iPad Air in landscape (2360x1640 at 2x).
const ipad = { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true };

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4173' },
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'ipad-webkit', use: { browserName: 'webkit', ...ipad } },
    { name: 'ipad-chromium', use: { browserName: 'chromium', ...ipad } },
  ],
});
