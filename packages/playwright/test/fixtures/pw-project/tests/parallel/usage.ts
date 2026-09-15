import { appendFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { LeasedResource } from '../../../../dist/index.js';

export async function useAccount(
  page: Page,
  buyer: LeasedResource,
  testTitle: string,
  parallelIndex: number,
): Promise<void> {
  const start = Date.now();
  // Pretend to log in with the leased account: the page shows who is signed in.
  await page.setContent(
    `<h1 id="who">${buyer.metadata.email as string}</h1><p id="pw">${buyer.secrets.password.length} chars</p>`,
  );
  await page.waitForTimeout(40 + Math.floor(Math.random() * 120));
  const who = await page.textContent('#who');
  if (who !== buyer.metadata.email)
    throw new Error(`page shows ${who}, expected ${buyer.metadata.email as string}`);
  const end = Date.now();
  if (process.env.USAGE_LOG) {
    appendFileSync(
      process.env.USAGE_LOG,
      `${JSON.stringify({ resourceId: buyer.resourceId, leaseId: buyer.leaseId, start, end, worker: parallelIndex, test: testTitle })}\n`,
    );
  }
}
