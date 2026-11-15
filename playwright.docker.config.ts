import { defineConfig, devices } from '@playwright/test';

/**
 * Docker lab, browser tier: a real browser against the real Docker image (`npm run lab:up`), the way a user who runs
 * Nebulis in a container uses it. The app is served by the container itself at :18080, so there is no web server to
 * start. Run: npm run test:e2e:docker
 */
export default defineConfig({
  testDir: './tests/e2e-docker',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:18080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
