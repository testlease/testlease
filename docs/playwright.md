# Playwright guide

## Setup

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import { ensureRunId } from '@testlease/playwright';

ensureRunId(); // fixes TESTLEASE_RUN_ID once; workers inherit it (CI ids are detected automatically)

export default defineConfig({ workers: 8, fullyParallel: true /* … */ });
```

```ts
// tests/fixtures.ts
import { test as base } from '@playwright/test';
import { withTestLease } from '@testlease/playwright';

export const test = withTestLease(base, {
  client: { baseUrl: process.env.TESTLEASE_URL!, token: process.env.TESTLEASE_TOKEN },
  waitTimeoutMs: 60_000, // adapter default; the core/REST default is 0
  fixtures: {
    buyer: { pool: 'premium-buyers', scope: 'worker', tags: { region: 'nl' } },
    tenant: { pool: 'tenants', scope: 'test', secrets: false, ttlMs: 120_000 },
  },
});
export { expect } from '@playwright/test';
```

## What the fixture gives you

| Member                                             | Meaning                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `buyer.metadata` / `buyer.tags`                    | from the lease's frozen resource snapshot                                                     |
| `buyer.secret('password')` / `buyer.secrets`       | resolved once at acquisition (token needs `secrets:resolve`); `secrets: false` skips it       |
| `buyer.leaseId`, `buyer.resourceId`, `buyer.owner` | identifiers for logs and evidence                                                             |
| `await buyer.renew()`                              | manual heartbeat (automatic one runs anyway)                                                  |
| `await buyer.quarantine(reason)`                   | resource is unsafe: end the lease, block the resource, get a replacement before the next test |
| `buyer.ended`                                      | true after quarantine/expiry/release                                                          |
| `testleaseClient` fixture                          | the worker's client, for assertions about pool state                                          |

## Lifecycle

- **Worker scope**: acquired when the first test in a worker needs it; heartbeat every TTL/3;
  released when the worker exits. Owner `run/project/worker-N`, request id `${owner}#buyer`.
  If the worker is killed, nothing is released and the TTL frees the account; the replacement
  worker (same `parallelIndex`) takes over the still-active lease instead of waiting.
- **Test scope**: acquired before the test, released after it; owner adds `/test-<testId>`.
- Before every test an auto fixture replaces worker leases that ended (quarantine, expiry).
- After every test the same fixture attaches `testlease.json` (name configurable via
  `evidence: { attachmentName }`; `evidence: false` disables it).

## Evidence

```json
{
  "generatedAt": "…",
  "test": { "title": "…", "file": "…", "status": "passed", "retry": 0, "duration": 812 },
  "worker": { "parallelIndex": 2, "workerIndex": 5, "project": "chromium" },
  "leases": [
    {
      "fixture": "buyer",
      "scope": "worker",
      "leaseId": "lease_…",
      "pool": "premium-buyers",
      "resourceId": "buyer-03",
      "owner": "gha-483-1/chromium/worker-2",
      "principal": "ci",
      "ownerParts": { "runId": "gha-483-1", "project": "chromium", "worker": "worker-2" },
      "tags": { "region": "nl" },
      "acquiredAt": "…",
      "expiresAt": "…",
      "state": "ACTIVE",
      "expiredDuringUse": false,
      "heartbeat": { "running": true, "healthy": true, "renewals": 3, "failures": 0 },
      "tookOver": false,
      "reacquired": false,
      "secretsResolved": true,
      "waitedMs": 1256
    }
  ]
}
```

Reading a failure with it:

| Evidence                                               | Likely category                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `expiredDuringUse: true` or `heartbeat.healthy: false` | lease expiry / infrastructure — the account may have been reused by another worker after expiry |
| `quarantineReason` present                             | resource contamination reported by this test                                                    |
| `tookOver: true`                                       | this worker inherited a lease from a crashed predecessor; the account state may carry over      |
| `reacquired: true`                                     | the worker switched accounts mid-run                                                            |
| none of the above                                      | look at the application or the test                                                             |

Two leases on the same resource at the same time cannot appear (enforced by the database), which
is exactly why "resource collision" is not on the list.

## Sizing workers

Throughput is bounded by the pool size, not by `workers`. With more workers than resources the
extra workers block in fixture setup until an account frees up, and Playwright does not move
their assigned tests elsewhere. Either keep `workers <= pool size` or accept the wait and set
`waitTimeoutMs` accordingly. Playwright's _global_ `workers` caps per-project values.

## Dogfooding

`examples/playwright` runs 8 workers on 3 accounts and verifies from both the tests' usage log and
the server's event log that no account was ever used by two workers at once. The adapter's own
suite (`packages/playwright/test`) additionally kills a worker with `SIGKILL` and proves the TTL
recovers the account, and exercises quarantine + replacement and test-scoped leases with real
Chromium workers.
