---
'testlease': minor
'@testlease/core': minor
'@testlease/server': minor
'@testlease/client': minor
'@testlease/protocol': minor
'@testlease/mcp': minor
'@testlease/playwright': minor
---

Initial release: atomic SQLite-backed leases with TTL + heartbeat, FIFO waiting with rich
diagnostics, quarantine, idempotent acquisition, REST API with token auth, TypeScript client,
CLI (`serve`, `status`, `acquire`, `exec`, `doctor`, `mcp`, ...), Playwright fixtures with
sanitized evidence, and an MCP server (stdio + Streamable HTTP) that never exposes secret values.
