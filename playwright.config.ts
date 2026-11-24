import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests against the real stack (tests/e2e/global-setup.ts). Sequential: the tests share one database and
 * one worker, and the machine has limited memory. Artifacts go to %TEMP% (outside the OneDrive-synced workspace);
 * evidence is written explicitly by the tests (AISLEFORGE_EVIDENCE_ROOT).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  outputDir: path.join(os.tmpdir(), 'aisleforge-e2e', 'playwright-output'),
  reporter: [['list'], ['json', { outputFile: path.join(os.tmpdir(), 'aisleforge-e2e', 'report.json') }]],
  use: {
    baseURL: 'http://localhost:4173',
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
