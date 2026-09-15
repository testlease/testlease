# ADR-0005: MCP over stdio (bridge) and Streamable HTTP (in-server)

**Status:** Accepted — 2026-09-15

## Context

Agent hosts either spawn a local MCP server process (stdio) or connect to a remote one
(Streamable HTTP). TestLease's state lives in one server process (ADR-0009), so an MCP server
must not become a second source of truth.

## Decision

- **stdio**: `testlease mcp --url <server>` starts an MCP server that talks to the TestLease
  HTTP server through the normal client. Many agents can run their own bridge; all of them see
  one state. The bridge never opens the SQLite file.
- **Streamable HTTP**: the TestLease server mounts `/mcp` and calls the in-process API bound to
  the token's principal. Sessions are per token; a session id presented with a different token
  is rejected (403). Host/Origin validation is port-agnostic and always on for loopback binds.
- Both transports use the same `createTestLeaseMcpServer(api, owner)`; the SDK is the official
  `@modelcontextprotocol/server` v2 (spec 2026-07-28) with tool annotations
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`).
- Owner of MCP-acquired leases: `mcp:<principal>:<session>` (HTTP) or the bridge's configured
  owner (stdio). Closing a session **does not release leases**; the TTL does. Agents renew
  explicitly with `testlease_renew`.
- The MCP default wait is 0 seconds (fail fast with a diagnostic) because a tool call that
  silently blocks for a minute is indistinguishable from a hang to an agent.

## Alternatives considered

- **stdio server embedding the engine directly** (open the SQLite file): two processes with
  independent waiting queues; fairness and diagnostics would fragment.
- **Auto-heartbeat inside the MCP server**: keeps forgotten leases alive as long as the session
  lives, defeating the TTL safety net. Rejected.
- **Auto-release on session close**: the agent may have launched a test that is still using the
  resource. Rejected; TTL handles it.

## Consequences

- The agent must call `testlease_release`; if it does not, the TTL recovers the resource — this
  is tested over both transports.
- `/mcp` shares the REST token authenticator, so one token config serves humans, runners and agents.
