# Agents sharing an API key

Two agents share one rate-limited API key. Each acquires the key over MCP; a runner with its own
token uses the lease on the agent's behalf (`delegateFor`, ADR-0016). The agents learn _that_ an
`apiKey` exists, never its value.

```
agent-a ──MCP acquire──▶ ┌───────────┐ ──▶ llm-key-01  LEASED  owner=agent:agent-a/summarize-issues
agent-b ──MCP acquire──▶ │ TestLease │      (agent-b waits, FIFO)
                         └───────────┘
runner  ──testlease exec --lease <id>──▶ resolves apiKey for agent-a, heartbeats, releases
```

```bash
pnpm build          # from the repository root
cd examples/agents
pnpm demo
```

The demo starts a server with [`testlease.yml`](testlease.yml), runs both agents concurrently
through the stdio bridge, runs `testlease exec --lease <id> -- node use-key.mjs` with the runner
token for each lease, and then checks the server's event log:

- the key never had two holders, and the second agent waited for the first;
- every `LEASE_SECRETS_RESOLVED` and `LEASE_RELEASED` event records `onBehalfOf: agent-a|agent-b`;
- an agent token asking for the key gets `FORBIDDEN` (the 403 warnings in the server log are
  these expected refusals);
- no MCP response and no event contains the key value.

## The tokens

| Token     | Scopes                                   | `delegateFor`        | Given to                       |
| --------- | ---------------------------------------- | -------------------- | ------------------------------ |
| `agent-a` | `lease:read`, `lease:write`, `pool:read` | —                    | the agent's MCP server         |
| `agent-b` | `lease:read`, `lease:write`, `pool:read` | —                    | the agent's MCP server         |
| `runner`  | the same plus `secrets:resolve`          | `agent-a`, `agent-b` | the process that runs the work |

Never give the runner token to an agent that has a shell: with it the agent could run
`testlease exec --lease <id> -- env` and read the key. See [docs/agents.md](../../docs/agents.md).
