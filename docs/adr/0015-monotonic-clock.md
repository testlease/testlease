# ADR-0015: Monotonic server clock for expiry

**Status:** Accepted — 2026-09-15 (v0.2)

## Context

Expiry is decided by comparing `expiresAt` with "now". v0.1 used `Date.now()`. A forward NTP
correction of two minutes would expire every lease with less than two minutes left at once; a
backward correction would keep dead workers' leases alive longer.

## Decision

The engine's default clock is **wall time at startup plus monotonic elapsed time**
(`performance.now()`). While the process runs, system clock changes cannot move "now". After a
restart the clock re-anchors to the wall clock, which is the unit `expiresAt` is stored in.
`/healthz` reports `wallClockDriftMs` so operators can see when the system clock has moved.

## Alternatives considered

- Re-anchoring when drift exceeds a threshold: reintroduces the jump, just later.
- Storing expiry as monotonic offsets: meaningless across restarts.

## Consequences

- If the system clock is corrected by a large amount, TestLease's notion of time lags the wall
  clock until the next restart; TTL displays in the CLI (which uses the local wall clock) may look
  off by that amount. Leasing correctness is unaffected.
