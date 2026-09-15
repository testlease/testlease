import { test as base, expect } from '@playwright/test';
import { withTestLease } from '@testlease/playwright';

export const test = withTestLease(base, {
  client: {
    baseUrl: process.env.TESTLEASE_URL ?? 'http://127.0.0.1:4747',
    token: process.env.TESTLEASE_TOKEN, // not needed for a local insecure-local server
  },
  waitTimeoutMs: 60_000,
  fixtures: {
    // One premium buyer per worker for the whole worker lifetime.
    buyer: { pool: 'premium-buyers', scope: 'worker', tags: { tier: 'premium' } },
  },
});

export { expect };
