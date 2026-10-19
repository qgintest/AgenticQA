import { defineConfig, devices, type Project } from '@playwright/test';
import { env } from './src/config/env';

const DIAGNOSTICS = '**/diagnostics/**';

const projects: Project[] = [
  {
    name: 'regression',
    testIgnore: DIAGNOSTICS,
    use: { ...devices['Desktop Chrome'] },
  },
];

// The deliberately failing scenario only exists when explicitly enabled, so the normal suite
// (and `npm test` in CI) can never pick it up by accident.
if (env.deliberateFailure !== 'off') {
  projects.push({
    name: 'deliberate-failure',
    testMatch: DIAGNOSTICS,
    use: { ...devices['Desktop Chrome'] },
  });
}

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  globalSetup: require.resolve('./tests/global-setup'),

  // The AUT storefront runs `next dev`, which compiles routes on first hit; keep generous ceilings.
  timeout: 90_000,
  expect: { timeout: 15_000 },

  fullyParallel: true,
  forbidOnly: env.isCI,
  // One retry in CI surfaces flakiness as "flaky" in the report instead of hiding it.
  retries: env.isCI ? 1 : 0,
  // The AUT storefront is `next dev`; at 3 workers it reset connections for JS chunks under load.
  workers: Number(process.env.AQA_WORKERS ?? 2),

  reporter: [
    [env.isCI ? 'github' : 'list'],
    ['html', { outputFolder: 'reports/html', open: 'never' }],
    ['json', { outputFile: 'reports/results.json' }],
    ['junit', { outputFile: 'reports/junit.xml' }],
  ],

  use: {
    baseURL: env.storefrontUrl,
    locale: 'en-US',
    timezoneId: 'Europe/Copenhagen',
    navigationTimeout: 45_000,
    actionTimeout: 15_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },

  metadata: {
    storefrontUrl: env.storefrontUrl,
    backendUrl: env.backendUrl,
    countryCode: env.countryCode,
    deliberateFailure: env.deliberateFailure,
  },

  projects,
});
