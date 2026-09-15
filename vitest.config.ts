import { defineConfig } from 'vitest/config';

const common = {
  globals: false,
  environment: 'node' as const,
  include: [] as string[],
};

export default defineConfig({
  test: {
    ...common,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/index.ts', 'packages/cli/src/**', 'packages/**/bin/**'],
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
