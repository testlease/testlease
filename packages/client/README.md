# @testlease/client

TypeScript client for [TestLease](https://github.com/testlease/testlease): acquire an exclusive,
expiring lease on a shared test resource, keep it alive automatically, release it when done.

```ts
import { TestLeaseClient } from '@testlease/client';

const client = new TestLeaseClient({
  baseUrl: process.env.TESTLEASE_URL!,
  token: process.env.TESTLEASE_TOKEN, // omit for a local insecure-local server
  owner: `${process.env.GITHUB_RUN_ID}/chromium/worker-${process.env.WORKER}`,
});

const lease = await client.acquireLease({
  pool: 'premium-buyers',
  tags: { region: 'nl' },
  waitTimeoutMs: 60_000,
});
lease.metadata.email; // public metadata from the lease's frozen snapshot
await lease.secret('password'); // needs the secrets:resolve scope; never log it
// heartbeat is running (TTL/3, unref'd timer)
await lease.release(); // or lease.quarantine('account locked')
lease.evidence(); // sanitized summary for your report
```

- `acquire()` generates a `clientRequestId`, so a retry after a lost response returns the same
  lease instead of a second one.
- Errors are `TestLeaseError` with stable `code`s (`ACQUIRE_TIMEOUT`, `POOL_EXHAUSTED`,
  `LEASE_EXPIRED`, `LEASE_OWNERSHIP_MISMATCH`, `UNAVAILABLE`, …).
- The `Lease` handle stops its heartbeat on release/quarantine or when the server says the lease
  is gone; `lease.heartbeat` reports health for evidence.
