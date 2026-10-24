# @testlease/server

## 0.4.0

### Minor Changes

- 4181f10: Add token delegation: `auth.tokens[].delegateFor` lets a runner token resolve secrets, renew and release leases acquired by the listed tokens, so an agent can acquire over MCP without `secrets:resolve` and a runner can use the lease with `testlease exec --lease <id>`. The owner must still match; quarantine and `force` are not delegated. Delegated events record `onBehalfOf`. See ADR-0016.

### Patch Changes

- a86b1b6: Position TestLease for AI agents as well as parallel test workers: updated package descriptions, CLI help, OpenAPI description and MCP server instructions (the MCP instructions now tell agents to hand the lease to a delegated runner). No tool, metric or environment variable names change. New `docs/agents.md` and `examples/agents`.
- Updated dependencies [a86b1b6]
- Updated dependencies [4181f10]
  - @testlease/mcp@0.4.0
  - @testlease/core@0.4.0
  - @testlease/protocol@0.4.0

## 0.3.0

### Minor Changes

- 50d98d8: Add pool-scoped event history: `TestLeaseApi.listPoolEvents(pool, { sinceMs, limit })`, served by
  `GET /v1/pools/:pool/events?since=&limit=` (scope `pool:read`, pool allow-lists apply) and
  `TestLeaseClient.listPoolEvents`. Events are returned newest first; `since` is inclusive, `limit`
  defaults to 1000 and values above 5000 are capped. Unlike resource history, this includes
  `ACQUIRE_TIMEOUT` events, which have no resource. Custom implementations of `TestLeaseApi` must
  add the new method.

### Patch Changes

- Updated dependencies [50d98d8]
- Updated dependencies [8088e63]
- Updated dependencies [1ae3da1]
  - @testlease/protocol@0.3.0
  - @testlease/core@0.3.0
  - @testlease/mcp@0.3.0

## 0.2.1

### Patch Changes

- 9d83df0: Report the real package version: `testlease --version`, `/healthz`, the client user-agent and the
  MCP server identity read the version from `package.json` instead of a hard-coded `0.1.0` (the
  published 0.2.0 introduced itself as 0.1.0). `testlease doctor` no longer tells you to run
  `testlease doctor` when the server is unreachable.
- Updated dependencies [9d83df0]
  - @testlease/mcp@0.2.1
  - @testlease/core@0.2.1
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
  - @testlease/core@0.2.0
  - @testlease/protocol@0.2.0
  - @testlease/mcp@0.2.0

## 0.1.0

### Minor Changes

- f975992: Initial release: atomic SQLite-backed leases with TTL + heartbeat, FIFO waiting with rich
  diagnostics, quarantine, idempotent acquisition, REST API with token auth, TypeScript client,
  CLI (`serve`, `status`, `acquire`, `exec`, `doctor`, `mcp`, ...), Playwright fixtures with
  sanitized evidence, and an MCP server (stdio + Streamable HTTP) that never exposes secret values.

### Patch Changes

- Updated dependencies [f975992]
  - @testlease/core@0.1.0
  - @testlease/protocol@0.1.0
  - @testlease/mcp@0.1.0
