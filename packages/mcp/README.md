# @testlease/mcp

Model Context Protocol server for [TestLease](https://github.com/testlease/testlease). Lets an
AI agent coordinate shared test resources — inspect pools, acquire, renew, release — **without
ever receiving secret values** (only secret _names_).

Usually consumed through the CLI:

```bash
testlease mcp --url http://127.0.0.1:4747        # stdio, for agent hosts that spawn servers
# or connect a Streamable HTTP client to http://127.0.0.1:4747/mcp (served by `testlease serve`)
```

Embed it in a custom host:

```ts
import { createTestLeaseMcpServer, serveStdio, createMcpHttpHandler } from '@testlease/mcp';
```

Tools: `testlease_list_pools`, `testlease_pool_status`, `testlease_acquire`, `testlease_get_lease`,
`testlease_renew`, `testlease_release`, `testlease_lease_events` (+ `testlease_quarantine` when
enabled). Resources: `testlease://pools`, `testlease://pools/{pool}`, `testlease://leases/{leaseId}`.
Built on `@modelcontextprotocol/server` v2. Design: ADR-0004 and ADR-0005 in the repository.
