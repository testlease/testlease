---
'testlease': minor
'@testlease/core': minor
'@testlease/server': minor
'@testlease/client': minor
'@testlease/protocol': minor
'@testlease/mcp': minor
'@testlease/playwright': minor
---

v0.2: operate it without restarts and survive them.

- Configuration reload via `SIGHUP`, `testlease reload` or `POST /v1/config/reload`: validated
  first, applied atomically (pools, resources, tokens), waiters served from new resources.
- Client retries acquisitions through `SERVER_SHUTTING_DOWN`/connection failures within the wait
  budget using the same `clientRequestId`; Playwright runs survive a server restart.
- Tokens may carry a `pools` allow-list; `whoami` shows it; violations are `FORBIDDEN`.
- Heartbeats are counted on the lease (`renewCount`) instead of one `LEASE_RENEWED` event each
  (`history.recordRenewals` restores the old behaviour); events and ended leases are pruned after
  `history.retention` (30d). Migration 2 (append-only).
- New: `GET /v1/leases` + `testlease leases`, `GET /metrics` (Prometheus text),
  `GET /openapi.json` (with a route/spec consistency test), monotonic server clock with
  `wallClockDriftMs` in `/healthz`, `examples/pytest` (stdlib client + fixture, run in CI).
