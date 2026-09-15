import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * In-process tests import workspace packages from source so that coverage is attributed to
 * `src`. Child processes spawned by the CLI, MCP-stdio and Playwright suites still run the
 * built `dist` (that is the point of those suites), which V8 coverage cannot observe.
 */
const alias = {
  '@testlease/protocol': pkg('protocol'),
  '@testlease/core': pkg('core'),
  '@testlease/client': pkg('client'),
  '@testlease/server': pkg('server'),
  '@testlease/mcp': pkg('mcp'),
};

const common = {
  globals: false,
  environment: 'node' as const,
  include: [] as string[],
};

export default defineConfig({
  resolve: { alias },
  test: {
    ...common,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['packages/*/src/**/*.ts'],
      // The CLI and the Playwright adapter run in spawned processes (covered end to end by
      // their own suites, not measurable in-process).
      exclude: [
        'packages/*/src/index.ts',
        'packages/cli/src/**',
        'packages/playwright/src/**',
        'packages/**/bin/**',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
        'packages/core/src/domain/**': { lines: 90, functions: 90, branches: 80, statements: 90 },
      },
    },
    projects: [
      {
        test: {
          ...common,
          name: 'unit',
          include: ['packages/*/test/unit/**/*.test.ts'],
          testTimeout: 15_000,
        },
      },
      {
        test: {
          ...common,
          name: 'concurrency',
          include: ['packages/core/test/concurrency/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          ...common,
          name: 'integration',
          include: [
            'packages/server/test/integration/**/*.test.ts',
            'packages/client/test/integration/**/*.test.ts',
            'packages/cli/test/integration/**/*.test.ts',
          ],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          ...common,
          name: 'mcp',
          include: ['packages/mcp/test/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          ...common,
          name: 'playwright',
          include: ['packages/playwright/test/**/*.test.ts'],
          testTimeout: 180_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
