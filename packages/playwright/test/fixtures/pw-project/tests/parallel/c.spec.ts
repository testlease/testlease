import { test, expect } from '../../fixtures.js';
import { useAccount } from './usage.js';

for (let i = 1; i <= 8; i++) {
  test('c checkout scenario ' + i, async ({ page, buyer }, testInfo) => {
    expect(buyer.leaseId).toMatch(/^lease_/);
    expect(buyer.secrets.password).toBeTruthy();
    await useAccount(page, buyer, testInfo.title, testInfo.parallelIndex);
  });
}
