import { test as base, expect } from '@playwright/test';
import { withTestLease } from '../../../dist/index.js';

export const test = withTestLease(base, {
  client: {
    baseUrl: process.env.TESTLEASE_URL!,
    token: process.env.TESTLEASE_TOKEN,
    requestTimeoutMs: 10_000,
  },
  waitTimeoutMs: 45_000,
  fixtures: {
    buyer: {
      pool: process.env.TESTLEASE_POOL ?? 'accounts',
      scope: 'worker',
      tags: process.env.TESTLEASE_TAG_REGION ? { region: process.env.TESTLEASE_TAG_REGION } : {},
    },
    scratch: { pool: 'scratch', scope: 'test', secrets: false },
  },
});

export { expect };
