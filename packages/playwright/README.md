# @testlease/playwright

Playwright fixtures for [TestLease](https://github.com/testlease/testlease): each worker (or each
test) receives an exclusive, heartbeated lease on a shared test resource and returns it
automatically. Every test gets a sanitized `testlease.json` attachment.

```ts
import { test as base } from '@playwright/test';
import { withTestLease } from '@testlease/playwright';

export const test = withTestLease(base, {
  client: { baseUrl: process.env.TESTLEASE_URL!, token: process.env.TESTLEASE_TOKEN },
  fixtures: {
    buyer: { pool: 'premium-buyers', scope: 'worker', tags: { region: 'nl' } },
    scratchTenant: { pool: 'tenants', scope: 'test', secrets: false },
  },
});

test('checkout', async ({ page, buyer }) => {
  await login(page, { email: buyer.metadata.email as string, password: buyer.secret('password') });
  // …
  if (broken) await buyer.quarantine('account locked'); // next test in this worker gets a replacement
});
```

- Owner: `<run id>/<project>/worker-<parallelIndex>` (call `ensureRunId()` in
  `playwright.config.ts` so every worker shares the run id). A replacement worker after a crash
  takes over the previous lease via the idempotent request id.
- A worker that is killed never releases; the server-side TTL frees the resource.
- Default `waitTimeoutMs` is 60 s; `heartbeat`, `evidence` and `runId` are configurable.
- Requires `@playwright/test >= 1.40`.

Guide: https://github.com/testlease/testlease/blob/main/docs/playwright.md
