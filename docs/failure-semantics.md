# Failure semantics

What TestLease guarantees in the situations that actually happen in CI, and how each is tested.

| Situation                                 | Behaviour                                                                                                     | Test                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Client disappears without releasing       | lease expires at `expiresAt`; resource `AVAILABLE`; `LEASE_EXPIRED` event with `lastHeartbeatAt`, `overdueMs` | core `crash recovery`, HTTP `client that dies`, Playwright `killed worker` |
| Client disappears **while waiting**       | waiter removed on socket close; never assigned a lease                                                        | HTTP `client cancellation` (7/10 aborted, exactly 3 served)                |
| Server restarts                           | active leases kept; overdue expired on start; quarantine kept; waiters got `SERVER_SHUTTING_DOWN` at shutdown | core `restart keeps live leases`, HTTP `server restart`                    |
| Heartbeat delayed but before expiry       | renew succeeds; expiry moves forward                                                                          | core `renewed lease does not expire`                                       |
| Heartbeat arrives after expiry            | `LEASE_EXPIRED`; lease not resurrected; successor untouched                                                   | core `renew racing with expiry`                                            |
| Network response lost, request retried    | same `clientRequestId` → same lease (`reused: true`)                                                          | core `idempotent acquisition`, HTTP `lost response`                        |
| Same key, different request               | `IDEMPOTENCY_CONFLICT`                                                                                        | core                                                                       |
| Resource becomes quarantined              | never selected until restored; waiters woken on restore                                                       | core `quarantine`, concurrency `never selected`, Playwright `replacement`  |
| Pool exhausted, wait = 0                  | `POOL_EXHAUSTED` immediately with the diagnostic                                                              | core, HTTP, CLI (exit 3)                                                   |
| Pool exhausted, waited                    | `ACQUIRE_TIMEOUT` with the diagnostic and an event                                                            | core, HTTP                                                                 |
| No resource matches the tags              | `NO_MATCHING_RESOURCE` immediately with known values                                                          | core, HTTP, CLI                                                            |
| Lease already expired, then released      | `outcome: already_expired`, successor untouched                                                               | core                                                                       |
| Release called twice / concurrently       | one `released`, the rest `already_released`; one event                                                        | concurrency `release is idempotent`                                        |
| Wrong owner or wrong token                | `LEASE_OWNERSHIP_MISMATCH` (`details.mismatch`)                                                               | core, HTTP token mode, MCP cross-principal                                 |
| Config changed under an active lease      | lease keeps its snapshot; new leases see new config                                                           | core `active-lease resource snapshot`                                      |
| Resource removed from config while leased | stays `LEASED`; `DISABLED` when the lease ends                                                                | core `configuration sync`                                                  |
| Two processes write one SQLite file       | still no double lease (unique index + BEGIN IMMEDIATE)                                                        | concurrency `multi-process`                                                |

## The acquisition diagnostic

Both `POOL_EXHAUSTED` and `ACQUIRE_TIMEOUT` carry the same structured `details`
(`pool, requested, waitedMs, resources[], waiters, oldestWaiterMs`) and a message like:

```
No matching resource became available within 60s.

Pool: premium-buyers
Requested:
  region=nl
  paymentMethod=ideal

Resources:
  buyer-01  LEASED       owner=gha-483-1/chromium/worker-1  expires in 04:31  (checkout)
  buyer-02  LEASED       owner=gha-483-1/chromium/worker-2  expires in 07:12
  buyer-03  QUARANTINED  account locked by fraud check

Waiters: 2 (oldest 41s)
```

It never contains secret values or references.
