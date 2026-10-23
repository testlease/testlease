---
'@testlease/core': minor
'@testlease/server': minor
'testlease': minor
---

Add token delegation: `auth.tokens[].delegateFor` lets a runner token resolve secrets, renew and release leases acquired by the listed tokens, so an agent can acquire over MCP without `secrets:resolve` and a runner can use the lease with `testlease exec --lease <id>`. The owner must still match; quarantine and `force` are not delegated. Delegated events record `onBehalfOf`. See ADR-0016.
