import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;
const isCI = Boolean(process.env.CI);
const fullRegression = Boolean(process.env.FULL_REGRESSION);
/** When dist/ is prebuilt (CI artifact), only start preview — skip a second production build. */
const skipBuild = Boolean(process.env.PLAYWRIGHT_SKIP_BUILD) || Boolean(process.env.PLAYWRIGHT_BASE_URL);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: !fullRegression,
  forbidOnly: isCI,
  // PRs fail fast; full/nightly regression may retry once for flake isolation.
  retries: fullRegression ? 1 : 0,
  // Two workers on PR CI; keep heavy/full serial to protect WebGL stability.
  workers: fullRegression ? 1 : (isCI ? 2 : undefined),
  // Stop after a couple of failures in a focused suite — cascading noise wastes minutes.
  maxFailures: isCI ? 2 : undefined,
  // Fast default; expensive tests call test.setTimeout(...).
  timeout: 45_000,
  // Cross-OS pixel baselines (local Windows agents vs ubuntu CI) need a shared path
  // without the platform suffix; threshold absorbs font/AA differences.
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}',
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.06,
      animations: 'disabled',
    },
  },
  reporter: isCI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: skipBuild
          ? `npx vite preview --host 127.0.0.1 --port ${port}`
          : `npm run build && npx vite preview --host 127.0.0.1 --port ${port}`,
        url: baseURL,
        reuseExistingServer: !isCI,
        timeout: 180_000,
      },
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'tablet-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 768, height: 1024 },
        deviceScaleFactor: 2,
        hasTouch: true,
      },
    },
    {
      name: 'phone-390',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
      },
    },
    {
      name: 'desktop-webkit',
      use: {
        ...devices['Desktop Safari'],
        // Lower resolution + 1x DPR reduces WebGL/canvas pressure on Linux SW WebKit.
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        // Continuous video encoding of WebGL canvases is a common WebKit crash source in CI.
        video: 'off',
      },
    },
  ],
});
