# ADR-0009: In-process FIFO waiting; one server per database

**Status:** Accepted — 2026-09-15

## Context

Eight workers, three accounts: five must wait, none may spin against the database, and a
worker that gives up (or dies while waiting) must not receive a resource nobody will use.

## Decision

- Acquisitions that cannot be satisfied immediately join an **in-process FIFO queue per pool**.
  The queue is re-evaluated when a resource is freed (release, expiry, restore) — no polling.
- **Guarantee:** waiters of a pool are offered a freed resource in arrival order. A later waiter
  is served before an earlier one only when the earlier one's tags do not match the freed
  resource. New arrivals do not jump ahead of compatible waiters.
- **Cancellation:** every waiter has a deadline (`waitTimeoutMs`, capped by `server.maxWait`)
  and an `AbortSignal`. The HTTP server aborts the acquisition when the client's connection
  closes, so a disconnected waiter is removed from the queue instead of being assigned a lease.
- **Timeouts produce a diagnostic**, not a one-liner: pool, requested tags, every resource with
  state/owner/expiry/quarantine reason, waiter count and oldest wait; recorded as
  `ACQUIRE_TIMEOUT` events. `POOL_EXHAUSTED` (wait = 0), `ACQUIRE_TIMEOUT` (waited) and
  `NO_MATCHING_RESOURCE` (nothing could ever match) are distinct codes.
- **Topology contract:** one TestLease server, many clients, one SQLite database. Two servers
  writing the same file stay _correct_ (database-level guarantees) but do not share a queue, so
  fairness is not defined across them. We do not claim multi-server support.

## Alternatives considered

- **Polling the database** from waiters: busy loops and no ordering.
- **A persistent queue table**: allows multi-server fairness but needs cross-process wakeups
  (notifications) SQLite does not provide; deferred until a real need appears.
- **Random selection** among waiters: simpler, unfair under sustained load.

## Consequences

- HTTP long-polls can be idle for minutes; the server disables its request timeout for them and
  clients set their timeout to `waitTimeoutMs + grace`.
- Idempotent retries interact safely with waiting: a retry that arrives while the original is
  still queued becomes a second waiter that returns the same lease once one of them wins.
