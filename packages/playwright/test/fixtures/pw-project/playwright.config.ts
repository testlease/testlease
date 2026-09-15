import { defineConfig } from '@playwright/test';

const outputDir = process.env.PW_OUTPUT_DIR ?? './test-results';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  // Global cap: per-project `workers` cannot exceed this (Playwright defaults it to half the cores).
  workers: 8,
  retries: 0,
  forbidOnly: true,
  reporter: [
    ['dot'],
    ['json', { outputFile: process.env.PW_JSON_REPORT ?? `${outputDir}/report.json` }],
  ],
  outputDir,
  timeout: 60_000,
  use: { browserName: 'chromium', headless: true },
  projects: [
    { name: 'parallel', testDir: './tests/parallel', workers: 8 },
    { name: 'crash', testDir: './tests/crash', workers: 1 },
    { name: 'quarantine', testDir: './tests/quarantine', workers: 1 },
    { name: 'testscoped', testDir: './tests/testscoped', workers: 4 },
  ],
});
