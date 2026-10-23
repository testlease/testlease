# ADR-0016: Token delegation for agent hand-off

**Status:** Accepted — 2026-10-22 (v0.4)

## Context

The recommended agent workflow (`docs/mcp.md`) is: an agent acquires a lease over MCP with a token
that has no `secrets:resolve`, and a separate runner uses the credentials, e.g.
`testlease exec --lease <id>`. Ownership is principal **and** owner (ADR-0003), so the runner, which
authenticates with its own token, was rejected with `LEASE_OWNERSHIP_MISMATCH`. The only way
through was `lease:admin` with `force`, which hands the runner every lease on the server. In
practice an agent could not use a credential without seeing it (ADR-0004).

## Decision

- Tokens accept an optional **`delegateFor`** list of other token names. A delegate passes the
  principal check on leases acquired by those principals for exactly three actions: **resolve
  secrets, renew and release**. Those are the actions `exec --lease` performs.
- The **owner check is unchanged**: the delegate must present the lease's owner (`client.attach`
  already does). Quarantine, force and admin operations do not accept delegation.
- Delegation is **not transitive**. Configuration rejects unknown targets, self-delegation and a
  target that itself delegates.
- Scopes and `pools` still apply to the delegate: it needs `secrets:resolve` to resolve and cannot
  reach a lease outside its pools.
- Events written by a delegate record `principal` (the delegate) and `onBehalfOf` (the lease
  principal). No schema change: event details are JSON.
- Delegation is read from configuration per request and changes on reload. It is not part of the
  lease snapshot.

## Alternatives considered

- A server-side "run with secret" MCP tool: the agent never needs a runner, but the server would
  execute commands for agents, a much larger attack surface.
- Lease tokens (deferred in ADR-0014): a per-lease capability the agent passes to the runner.
  The agent would hold a credential that unlocks secrets, which is what ADR-0004 avoids.
- `lease:admin` for runners: works today, but grants force over every lease.

## Consequences

- Recommended agent layout: `agent` token (no `secrets:resolve`) for MCP, `runner` token with
  `secrets:resolve` and `delegateFor: [agent]` on the machine that executes work. Never give the
  runner token to an agent that has a shell.
- Audit trails show who acted for whom; `testlease_lease_events` exposes `onBehalfOf`.
