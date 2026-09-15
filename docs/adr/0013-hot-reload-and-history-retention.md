# ADR-0013: Configuration reload without restart; history retention

**Status:** Accepted — 2026-09-15 (v0.2)

## Context

v0.1 read the configuration once. Adding an account meant restarting the server, which failed
every waiting acquisition with `SERVER_SHUTTING_DOWN`. Separately, every heartbeat wrote a
`LEASE_RENEWED` event; with a 10 minute TTL that is one row per lease every ~3 minutes, forever.

## Decision

- **Reload**: `SIGHUP` or `POST /v1/config/reload` (`resource:admin`) re-reads the file, applies
  environment overrides and CLI flags, validates it _fully_ (schema, duplicates, secret
  references) and only then synchronises pools and resources in one transaction. Waiters are
  re-evaluated immediately, so a newly added resource is handed to the oldest compatible waiter.
  The token set is rebuilt from the new file. `server.host/port/db` cannot change at runtime and
  are reported as warnings. An invalid file is rejected with `CONFIG_INVALID` and the running
  configuration is untouched.
- **Renewals** are counted on the lease (`renewCount`, `lastHeartbeatAt`); a `LEASE_RENEWED`
  event is written only when the TTL changes or `history.recordRenewals: true`.
- **Retention**: events and _ended_ leases older than `history.retention` (default 30 days) are
  deleted on startup and hourly. Active leases and their events are never pruned.
- Both are recorded as migration 2 (`renew_count`, time indexes). Migrations stay append-only.

## Alternatives considered

- File watcher with automatic reload: surprising when an editor writes half a file; explicit
  reload keeps a human in the loop and gives a result to look at.
- Keeping one event per heartbeat: honest but useless at scale; the lease row already carries the
  evidence a failure investigation needs.
- Never pruning: SQLite handles millions of rows, but `testlease events` output and backups do not.

## Consequences

- Operators can grow a pool during a CI run.
- `LEASE_EXPIRED` still carries `lastHeartbeatAt`/`overdueMs`, so "did the heartbeat die" remains
  answerable without per-heartbeat events.
