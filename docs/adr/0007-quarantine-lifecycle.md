# ADR-0007: Quarantine lifecycle

**Status:** Accepted — 2026-09-15

## Context

A test sometimes discovers that its account is no longer safe for anyone: locked by a fraud
check, left with a corrupted cart, half-migrated. Releasing it would hand the problem to the
next worker and produce a misleading failure there.

## Decision

- `quarantine(leaseId, reason)` ends the caller's lease (`endReason: QUARANTINED`) and moves the
  resource to **`QUARANTINED`** with reason, timestamp and who did it. Quarantined resources are
  never candidates for acquisition.
- Quarantine is **ownership-checked** like release (principal + owner, or `force` with admin).
- A quarantined resource stays quarantined across restarts and configuration re-syncs until an
  operator calls `restore` (`resource:admin`), which makes it `AVAILABLE` (or `DISABLED` if the
  configuration removed it meanwhile) and wakes waiters.
- Resource-level quarantine (`POST /v1/resources/:id/quarantine`) exists for operators; it
  refuses a leased resource unless `force` ends the active lease.
- Quarantining an expired lease is refused (`LEASE_EXPIRED`): the resource may already be in
  use by a successor; use the resource-level operation instead.
- Configuration removal is a different state, **`DISABLED`**: resources removed from the file
  are disabled (deferred while leased), never deleted, so their history survives.

## Alternatives considered

- **Delete the resource**: loses evidence.
- **Auto-restore after a cooldown**: hides real problems; an operator should look.
- **Quarantine as a lease flag only**: the next acquisition would still pick the resource.

## Consequences

- `testlease inspect` shows quarantine reasons inline; acquisition diagnostics list quarantined
  resources so a timed-out worker can see *why* capacity shrank.
- The Playwright adapter acquires a replacement for a worker whose resource was quarantined.
