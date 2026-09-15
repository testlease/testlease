import { appendFileSync, mkdirSync } from 'node:fs';
import { test, expect } from './fixtures.js';
import { login } from './shop.js';

for (let i = 1; i <= 8; i++) {
  test('profile scenario ' + i, async ({ page, buyer }, testInfo) => {
    const start = Date.now();
    await login(page, { email: buyer.metadata.email as string, password: buyer.secrets.password });
    await expect(page.locator('#who')).toHaveText(buyer.metadata.email as string);
    await page.click('#checkout');
    await expect(page.locator('#status')).toHaveText('Order placed');
    await page.waitForTimeout(50 + Math.floor(Math.random() * 150));

    // Record which account this test used; scripts/run-demo.mjs proves usage never overlapped.
    mkdirSync('test-results', { recursive: true });
    appendFileSync(
      'test-results/usage.jsonl',
      JSON.stringify({
        test: testInfo.title,
        worker: testInfo.parallelIndex,
        resourceId: buyer.resourceId,
        leaseId: buyer.leaseId,
        start,
        end: Date.now(),
      }) + '\n',
    );
  });
}
