# @testlease/playwright

## 0.2.1

### Patch Changes

- 9d83df0: Report the real package version: `testlease --version`, `/healthz`, the client user-agent and the
  MCP server identity read the version from `package.json` instead of a hard-coded `0.1.0` (the
  published 0.2.0 introduced itself as 0.1.0). `testlease doctor` no longer tells you to run
  `testlease doctor` when the server is unreachable.
- Updated dependencies [9d83df0]
  - @testlease/client@0.2.1
  - @testlease/protocol@0.2.1

## 0.2.0

### Minor Changes

- 602b52b: v0.2: operate it without restarts and survive them.
  
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

### Patch Changes

- Updated dependencies [602b52b]
  - @testlease/client@0.2.0
  - @testlease/protocol@0.2.0

## 0.1.0

### Minor Changes

- f975992: Initial release: atomic SQLite-backed leases with TTL + heartbeat, FIFO waiting with rich
  diagnostics, quarantine, idempotent acquisition, REST API with token auth, TypeScript client,
  CLI (`serve`, `status`, `acquire`, `exec`, `doctor`, `mcp`, ...), Playwright fixtures with
  sanitized evidence, and an MCP server (stdio + Streamable HTTP) that never exposes secret values.

### Patch Changes

- Updated dependencies [f975992]
  - @testlease/client@0.1.0
  - @testlease/protocol@0.1.0
