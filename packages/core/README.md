# @testlease/core

The leasing engine of [TestLease](https://github.com/testlease/testlease): configuration schema,
SQLite persistence and migrations, the `LeaseService` state machine (atomic acquire, FIFO waiting,
TTL/heartbeat, quarantine, idempotency), evidence events and the secret-reference resolver.

Most users want the server (`testlease serve`) or the client; embed the core directly only for
custom hosts or tests:

```ts
import { createTestLease, validateConfig } from '@testlease/core';

const { config } = validateConfig({
  pools: { accounts: { resources: [{ id: 'a' }, { id: 'b' }] } },
});
const engine = await createTestLease({ config, dbPath: ':memory:' });
const { lease } = await engine.service.acquire({ pool: 'accounts', owner: 'me' });
engine.service.release(lease.leaseId, { owner: 'me' });
engine.close(); // active leases are kept in the database on purpose
```

Guarantees and their proofs are described in the
[ADRs](https://github.com/testlease/testlease/tree/main/docs/adr). Uses `better-sqlite3`
(prebuilt binaries; no compiler needed).
