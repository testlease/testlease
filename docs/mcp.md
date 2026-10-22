# MCP guide

TestLease speaks the Model Context Protocol (spec 2026-07-28, official TypeScript SDK v2) so an
agent can coordinate shared test resources the same way a CI worker does.

## Transports

| Transport       | How                                                                                                                | Owner of acquired leases                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| stdio           | agent host spawns `testlease mcp --url http://server:4747` (bridge to the HTTP server)                             | `$TESTLEASE_OWNER` or `mcp:<user@host>:<pid>` |
| Streamable HTTP | `POST http://server:4747/mcp` with `Authorization: Bearer <token>`; served by `testlease serve` (`mcp.http: true`) | `mcp:<token name>:<session>`                  |

Claude Desktop / Claude Code style configuration for stdio:

```json
{
  "mcpServers": {
    "testlease": {
      "command": "npx",
      "args": ["-y", "testlease", "mcp", "--url", "http://127.0.0.1:4747"],
      "env": { "TESTLEASE_TOKEN": "…", "TESTLEASE_OWNER": "mcp:my-agent" }
    }
  }
}
```

## Tools

| Tool                     | Annotations                                                                   | Input                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `testlease_list_pools`   | read-only, idempotent                                                         | —                                                                                             |
| `testlease_pool_status`  | read-only, idempotent                                                         | `{ pool }`                                                                                    |
| `testlease_acquire`      | state-changing                                                                | `{ pool, tags?, ttlSeconds?, waitSeconds? (default 0, max 120), purpose?, clientRequestId? }` |
| `testlease_get_lease`    | read-only                                                                     | `{ leaseId }`                                                                                 |
| `testlease_renew`        | idempotent                                                                    | `{ leaseId, ttlSeconds? }`                                                                    |
| `testlease_release`      | idempotent                                                                    | `{ leaseId }`                                                                                 |
| `testlease_lease_events` | read-only                                                                     | `{ leaseId }`                                                                                 |
| `testlease_diagnose`     | read-only, idempotent                                                         | `{ pool, windowMinutes? (default 1440, max 43200) }`                                          |
| `testlease_quarantine`   | **destructive**, only with `mcp.allowQuarantine: true` / `--allow-quarantine` | `{ leaseId, reason }`                                                                         |

Errors are tool results with `isError: true` and text `CODE: message` (for example
`POOL_EXHAUSTED: No matching resource is available right now …` followed by the full diagnostic).

`testlease_diagnose` explains pool-level causes of flaky tests over the last `windowMinutes`:
acquisitions and how long callers waited (nearest-rank p50/p95/max), immediate rejections
(`poolExhausted`) separately from wait timeouts (`acquireTimeouts`), expiries split into "never
heartbeated" and "heartbeat stopped" with the top 5 resources and owners, quarantines with their
reasons and the resources quarantined now, and the contention ratio (attempts that waited or were
rejected) with leases per resource. It reads at most 5000 events; `meta.possiblyTruncated` is true
when that limit was reached. Expiries recorded by the reaper can lag by up to one reaper tick, and
acquires aborted by the caller write no event (`meta.abortedAcquiresTracked: false`). Output is an
allow-list projection: counts, durations, resource ids, owners and quarantine reasons only.

`testlease_diagnose` computes its window start with the MCP process's clock (`Date.now()`), while
event times come from the server's monotonic clock. The two can differ — across machines over the
stdio bridge, and even in-process once the wall clock has been adjusted — so events at the window
edge may fall either way.

Resources: `testlease://pools`, `testlease://pools/{pool}` (with completion), `testlease://leases/{leaseId}`.

## What the agent sees

```json
{
  "leaseId": "lease_…",
  "pool": "premium-buyers",
  "resourceId": "buyer-02",
  "owner": "mcp:agent:3f2a9c1e",
  "state": "ACTIVE",
  "tags": { "region": "nl" },
  "metadata": { "email": "buyer02@example.test" },
  "availableSecretKeys": ["password"],
  "createdAt": "…",
  "expiresAt": "…",
  "ttlSeconds": 600,
  "reused": false,
  "waitedSeconds": 0
}
```

Never a secret value, never a secret reference. The adapter is typed against an API interface that
has no secret-resolution method, and every result passes an allow-list projection
([ADR-0004](adr/0004-mcp-never-receives-secrets.md)). The test suite connects real MCP clients
over both transports and scans every response for the configured secret values and references.

## Lifecycle expectations for agents

1. `testlease_pool_status` to see capacity.
2. `testlease_acquire` with a `purpose` and, for retries, a `clientRequestId`.
3. Run the work (a runner with its own `secrets:resolve` token resolves credentials, e.g.
   `testlease exec --lease <id> -- npm test`).
4. `testlease_renew` if the work outlives the TTL.
5. `testlease_release`. If the agent forgets or crashes, the TTL reclaims the resource; closing
   an MCP session never releases leases (an already-launched test may still be using them).

## Safety defaults

- No `force`, no resource-level quarantine/restore, no "list everything" tool.
- Session ids are bound to the token that created them (403 otherwise).
- Host/Origin validation on `/mcp` (loopback-only by default; `allowedHosts` when bound elsewhere).
- Default wait 0 s so a tool call never silently blocks; agents opt in with `waitSeconds`.
