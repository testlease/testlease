# ADR-0002: TTL + heartbeat lease model; shutdown never releases

**Status:** Accepted — 2026-09-15

## Context

Workers crash, CI jobs are cancelled, laptops close. A resource held by a dead process must
return to the pool without a human, but a resource held by a slow, healthy test must not be
taken away.

## Decision

- Every lease has a **TTL** (`ttlMs`, default per pool, capped by the pool's `maxTtl`; a request
  above the cap is rejected, never silently clamped).
- The owner **renews** ("heartbeats") before the TTL elapses. Renewal moves `expiresAt` to
  `now + ttl` and records `LEASE_RENEWED`.
- **Expiry is evaluated inside every write transaction** (`expireDueInTx(now)`) before the
  operation proceeds, so an expired lease is reclaimable the moment anyone touches the engine.
  A timer-driven sweeper armed for the earliest expiry is only an optimisation that wakes
  waiters promptly; correctness never depends on it.
- Renewing or releasing after expiry fails with `LEASE_EXPIRED` and never resurrects the lease;
  the resource may already belong to someone else.
- **Server shutdown and restart keep active leases.** Shutdown only fails *waiting*
  acquisitions with `SERVER_SHUTTING_DOWN`. On startup overdue leases are expired.
- The SDKs heartbeat automatically (interval = TTL/3 clamped to 1–60 s) with `unref()`ed timers,
  so a forgotten handle never keeps a process alive.

## Alternatives considered

- **Release on disconnect** (like a database session lock): impossible to distinguish a dead
  worker from a slow network, and it couples lease lifetime to a TCP connection the test
  runner may not keep open.
- **Very long TTLs without heartbeat**: simple, but a crash blocks the resource for the whole TTL.
- **Releasing everything on shutdown**: tempting for tidiness, wrong for correctness. A server
  restart does not mean the workers stopped using their accounts.

## Consequences

- Choose TTLs as "how long may a dead worker block a resource", not "how long is my test".
- Clock semantics are server-side; clients never send timestamps.
- The `LEASE_EXPIRED` event carries `lastHeartbeatAt` and `overdueMs`, which is the evidence
  needed to tell "worker died" from "heartbeat was too slow".
