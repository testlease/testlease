import { appendFileSync } from 'node:fs';
import { test, expect } from '../../fixtures.js';

test.describe.configure({ mode: 'serial' });

test('first test finds the account contaminated and quarantines it', async ({ buyer }) => {
  appendFileSync(
    process.env.Q_LOG!,
    `${JSON.stringify({ test: 1, resourceId: buyer.resourceId, leaseId: buyer.leaseId })}\n`,
  );
  await buyer.quarantine('account locked by fraud check');
  expect(buyer.ended).toBe(true);
});

test('second test in the same worker gets a replacement', async ({ buyer, testleaseClient }) => {
  appendFileSync(
    process.env.Q_LOG!,
    `${JSON.stringify({ test: 2, resourceId: buyer.resourceId, leaseId: buyer.leaseId })}\n`,
  );
  expect(buyer.ended).toBe(false);
  const pool = await testleaseClient.getPool(buyer.pool);
  expect(pool.counts.quarantined).toBe(1);
});
