# Agents guide

AI agents and parallel workers run into the same problem: a few scarce things that only one of
them may use at a time. TestLease models each of those things as a resource in a pool and gives a
caller an exclusive, expiring lease on one. This guide shows how to model agent resources, name
owners, pick TTLs, and hand credentials to a runner without the agent seeing them.

## Modelling resources

A resource is anything that must have **one holder at a time**. Put interchangeable resources in
one pool; use `tags` for what callers select on and `metadata` for what they may read.

| Resource                      | Pool               | Tags (matching)         | Secrets (references)        |
| ----------------------------- | ------------------ | ----------------------- | --------------------------- |
| rate-limited API key          | `api-keys`         | `provider`, `tier`      | `apiKey: env:LLM_KEY_01`    |
| logged-in browser profile     | `browser-profiles` | `site`, `locale`        | `password: env:SHOP_PW_01`  |
| test account / sandbox tenant | `tenants`          | `region`, `plan`        | `adminToken: env:TENANT_01` |
| physical or emulated device   | `devices`          | `platform`, `osVersion` | —                           |
| GPU slot or licensed seat     | `gpu-slots`        | `gpuType`               | —                           |

```yaml
pools:
  api-keys:
    defaultTtl: 2m
    maxTtl: 15m
    resources:
      - id: llm-key-01
        tags: { provider: example-llm, tier: standard }
        metadata: { rateLimit: 60/min }
        secrets: { apiKey: env:LLM_KEY_01 }
```

What the exclusive model covers today, and what it does not:

- **One key per agent at a time** works now: one resource per key, one lease per resource. An
  agent that needs a key waits (FIFO, up to `waitSeconds`) or fails fast with a diagnostic.
- **N concurrent users of one resource** (for example "this key allows 3 parallel callers") is
  not supported yet. Workaround: list the key as N resources with the same secret reference.
- **Cooldown after use** (rate-limit backoff before the next holder) is not supported yet. Today a
  resource is available again as soon as it is released.

Both are on the [roadmap](../README.md#roadmap).

## Owner naming

An owner is a free-form string the caller chooses; renew and release must present it. Use
`agent:<name>/<task>` so `testlease inspect` and the event log say who holds what and why:

```
llm-key-01   LEASED   agent:triage-bot/issue-1432   in 01:42
```

- stdio bridge: set `TESTLEASE_OWNER=agent:triage-bot/issue-1432` in the MCP server's `env`.
  Without it the owner is `mcp:<user@host>:<pid>`.
- Streamable HTTP: the owner is `mcp:<token name>:<session>` and cannot be chosen.

## TTL and renew

Agents do not heartbeat reliably: a model can think for minutes between tool calls, and a host
can drop the session without a word. So:

- Keep the TTL short (a few minutes). A forgotten lease then blocks a resource for minutes, not
  hours.
- Renew explicitly with `testlease_renew` before long steps, or let the runner hold the lease:
  `testlease exec --lease <id>` heartbeats every TTL/3 for as long as the command runs.
- Release when done. Closing an MCP session never releases leases, because a test the agent
  launched may still be using them; the TTL is the safety net.

## Streamable HTTP: owners are bound to the session

Over Streamable HTTP the owner includes the MCP session id. A new session (reconnect, host
restart) is a different owner and cannot renew or release the old session's leases; they expire
after their TTL. If your agent reconnects often, use the stdio bridge with a stable
`TESTLEASE_OWNER`, or keep TTLs short.

## Handing credentials to a runner

The MCP server never returns secret values (ADR-0004), so an agent cannot use a password or key
directly. A runner does it for the agent:

```yaml
auth:
  tokens:
    - name: agent # given to the MCP server; no secrets:resolve
      token: env:TESTLEASE_TOKEN_AGENT
      scopes: [lease:read, lease:write, pool:read]
    - name: runner # given to the process that runs the work
      token: env:TESTLEASE_TOKEN_RUNNER
      scopes: [lease:read, lease:write, pool:read, secrets:resolve]
      delegateFor: [agent]
```

1. The agent acquires over MCP and gets a `leaseId` plus `availableSecretKeys`.
2. The runner, with its own token, runs `testlease exec --lease <leaseId> -- <command>`. It
   resolves the secrets on the agent's behalf, puts them in the command's environment only,
   heartbeats, and releases when the command exits.
3. Delegated events record both identities: `principal: runner`, `onBehalfOf: agent`.

Delegation covers resolve, renew and release only. It is not transitive, does not grant
quarantine or `force`, and the runner token's own `pools` allow-list still applies (ADR-0016).

**Never give the runner token to an agent that has shell access.** An agent that can run
`testlease exec --lease <id> -- env` with that token reads every secret of the lease. Redaction in
`testlease exec` is best effort and does not stop deliberate exfiltration
([docs/exec.md](exec.md)). Keep the runner token in CI or in a process the agent cannot
control.

A complete, runnable version is in [examples/agents](../examples/agents): two agents share one API
key over MCP and a delegated runner uses it; the demo checks the event log.
