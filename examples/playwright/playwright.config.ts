import { defineConfig } from '@playwright/test';
import { ensureRunId } from '@testlease/playwright';

// Fix the run id once in the runner process; every worker inherits it through the environment,
// so all leases of this run share the owner prefix (e.g. gha-483-1/chromium/worker-2).
ensureRunId();

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: 8,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/report.json' }],
    ['html', { open: 'never' }],
  ],
  use: { browserName: 'chromium', headless: true },
  projects: [{ name: 'chromium' }],
});
