# Configuration

`testlease serve --config testlease.yml` (default `./testlease.yml` or `$TESTLEASE_CONFIG`).
Validation is strict: unknown keys, duplicate resource ids, invalid durations and unresolvable
secret references fail startup with a list of every problem. `testlease validate` checks a file
without starting a server; `testlease doctor` also checks connectivity and the token's scopes.

```yaml
server:
  host: 127.0.0.1 # default; anything else requires tokens (or allowInsecureRemote: true)
  port: 4747
  db: ./testlease.db # SQLite file; ':memory:' for throwaway runs
  maxWait: 10m # cap for waitTimeoutMs per request
  logLevel: info # fatal|error|warn|info|debug|trace|silent
  allowInsecureRemote: false # explicit, loudly logged opt-in
  requestBodyLimitBytes: 65536

auth:
  tokens:
    - name: ci # becomes the principal of leases acquired with this token
      token: env:TESTLEASE_TOKEN_CI # literal tokens (≥16 chars) are allowed but discouraged
      scopes: [lease:read, lease:write, pool:read, secrets:resolve]
    - name: ops
      token: env:TESTLEASE_TOKEN_OPS
      scopes: [lease:read, lease:write, lease:admin, pool:read, resource:admin]
    - name: agent # an MCP identity: no secrets:resolve
      token: env:TESTLEASE_TOKEN_AGENT
      scopes: [lease:read, lease:write, pool:read]
    - name: payments-team # restricted to specific pools (v0.2)
      token: env:TESTLEASE_TOKEN_PAYMENTS
      scopes: [lease:read, lease:write, pool:read, secrets:resolve]
      pools: [premium-buyers, payment-tenants]

mcp:
  http: true # serve MCP at /mcp on this server
  allowQuarantine: false # register testlease_quarantine for agents

history: # v0.2
  retention: 30d # events and ended leases older than this are pruned (active leases never)
  recordRenewals: false # true = one LEASE_RENEWED event per heartbeat (renewCount is always kept)

pools:
  premium-buyers:
    description: Premium buyers on staging
    defaultTtl: 10m # 1s … maxTtl
    maxTtl: 1h # default max(defaultTtl, 1h); ≤ 7d
    resources:
      - id: buyer-01 # unique across ALL pools
        enabled: true # false = DISABLED (kept for history)
        tags: { region: nl, paymentMethod: ideal, tier: premium } # matching surface (values → strings)
        metadata: { email: buyer01@example.test, note: Dutch premium buyer } # informational
        secrets: { password: env:BUYER_01_PASSWORD } # references only
```

## Environment overrides

| Variable                                                                  | Effect                                                                |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `TESTLEASE_CONFIG`                                                        | configuration file path                                               |
| `TESTLEASE_HOST`, `TESTLEASE_PORT`, `TESTLEASE_DB`, `TESTLEASE_LOG_LEVEL` | override `server.*`                                                   |
| `TESTLEASE_TOKEN`                                                         | adds a token named `default` with **all** scopes (Docker quick start) |
| `TESTLEASE_ALLOW_INSECURE_REMOTE=1`                                       | same as `server.allowInsecureRemote: true`                            |

Client-side: `TESTLEASE_URL`, `TESTLEASE_TOKEN`, `TESTLEASE_OWNER`, `TESTLEASE_RUN_ID`.

## Scopes

| Scope             | Allows                                                 |
| ----------------- | ------------------------------------------------------ |
| `pool:read`       | list/inspect pools and resources, resource events      |
| `lease:read`      | read leases, lease events, recent events               |
| `lease:write`     | acquire, renew, release, quarantine (own leases)       |
| `lease:admin`     | `force` on release/quarantine (acts on others' leases) |
| `resource:admin`  | quarantine/restore resources directly                  |
| `secrets:resolve` | `POST /v1/leases/:id/secrets` for own active leases    |

Default scopes when omitted: `lease:read, lease:write, pool:read`.

## What changes at restart

Configuration is the source of truth for _what exists_; the database for _runtime state_.

| Change                               | Effect on restart                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| new resource                         | registered `AVAILABLE` (`RESOURCE_REGISTERED`)                                      |
| changed tags/metadata/secrets        | live resource updated (`RESOURCE_UPDATED`); active leases keep their snapshot       |
| `enabled: false` or resource removed | `DISABLED` now, or when its current lease ends (`RESOURCE_DISABLED`); never deleted |
| resource re-added                    | `RESOURCE_ENABLED`, becomes `AVAILABLE`                                             |
| pool removed                         | its resources are disabled as above; the pool is hidden                             |
| quarantined resource                 | stays quarantined                                                                   |
| active lease                         | stays active; overdue leases are expired on startup                                 |
