---
'@testlease/mcp': minor
---

Add the read-only `testlease_diagnose` tool: `{ pool, windowMinutes? }` (default 1440, max 43200)
summarises why tests on a pool are flaky — waits and their percentiles, immediate rejections vs
wait timeouts, expiries (never heartbeated vs heartbeat stopped), quarantines and contention. The
output is an allow-list projection (`toMcpPoolDiagnosis`) with no secrets, secret references or
request fields. Existing tools are unchanged.
