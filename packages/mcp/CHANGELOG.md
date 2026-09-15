# @testlease/mcp

## 0.1.0

### Minor Changes

- f975992: Initial release: atomic SQLite-backed leases with TTL + heartbeat, FIFO waiting with rich
  diagnostics, quarantine, idempotent acquisition, REST API with token auth, TypeScript client,
  CLI (`serve`, `status`, `acquire`, `exec`, `doctor`, `mcp`, ...), Playwright fixtures with
  sanitized evidence, and an MCP server (stdio + Streamable HTTP) that never exposes secret values.

### Patch Changes

- Updated dependencies [f975992]
  - @testlease/protocol@0.1.0
