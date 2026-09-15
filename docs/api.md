# HTTP API (v1)

Base URL: `http://host:4747`. All bodies are JSON. Authentication: `Authorization: Bearer <token>`
(not needed in insecure-local mode). Every error is

```json
{ "error": { "code": "LEASE_OWNERSHIP_MISMATCH", "message": "…", "details": { "…": "…" } } }
```

Switch on `error.code`; HTTP status codes are a transport detail (400/401/403/404/409/413/500/503).

## Endpoints

| Method & path                                                 | Scope                                      | Purpose                                                                      |
| ------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| `GET /healthz`                                                | none                                       | `{status, version, uptimeMs, now, db.schemaVersion, auth.mode, mcp.http}`    |
| `GET /v1/whoami`                                              | any                                        | `{auth, principal, scopes}`                                                  |
| `GET /v1/pools`                                               | `pool:read`                                | `{pools: PoolSummary[]}`                                                     |
| `GET /v1/pools/:pool`                                         | `pool:read`                                | `PoolDetail` (resources with state/owner/expiry, waiters)                    |
| `GET /v1/resources/:id`                                       | `pool:read`                                | `ResourceView` (current configuration and state)                             |
| `GET /v1/resources/:id/events`                                | `pool:read`                                | `{events}`                                                                   |
| `POST /v1/resources/:id/quarantine`                           | `resource:admin`                           | body `{reason, force?}`                                                      |
| `POST /v1/resources/:id/restore`                              | `resource:admin`                           | `{resource}`                                                                 |
| `POST /v1/leases/acquire`                                     | `lease:write`                              | body `AcquireRequest` → `AcquireResponse` (long-polls up to `waitTimeoutMs`) |
| `GET /v1/leases/:id`                                          | `lease:read`                               | `LeaseView`                                                                  |
| `GET /v1/leases/:id/events`                                   | `lease:read`                               | `{events}`                                                                   |
| `POST /v1/leases/:id/renew`                                   | `lease:write`                              | body `{owner, ttlMs?}` → `{lease}`                                           |
| `POST /v1/leases/:id/release` (alias `DELETE /v1/leases/:id`) | `lease:write` (+`lease:admin` for `force`) | body `{owner, force?}` → `{lease, outcome}`                                  |
| `POST /v1/leases/:id/quarantine`                              | `lease:write` (+`lease:admin` for `force`) | body `{owner, reason, force?}` → `{lease, resource}`                         |
| `POST /v1/leases/:id/secrets`                                 | `secrets:resolve`                          | body `{owner}` → `{leaseId, resourceId, secrets}` — values, caller only      |
| `GET /v1/events?limit=100`                                    | `lease:read`                               | most recent events server-wide                                               |
| `ALL /mcp`                                                    | token                                      | MCP Streamable HTTP (see `docs/mcp.md`)                                      |

## AcquireRequest

```json
{
  "pool": "premium-buyers",
  "owner": "gha-483-1/chromium/worker-2",
  "tags": { "region": "nl" },
  "ttlMs": 600000,
  "waitTimeoutMs": 60000,
  "clientRequestId": "gha-483-1/chromium/worker-2#buyer",
  "purpose": "checkout regression",
  "context": { "testTitle": "…", "ciJobUrl": "…" }
}
```

| Field                | Notes                                                                          |
| -------------------- | ------------------------------------------------------------------------------ |
| `pool`               | required                                                                       |
| `owner`              | required; stable logical identity, no whitespace, ≤200 chars; not a credential |
| `tags`               | optional; all pairs must match the resource's tags                             |
| `ttlMs`              | optional; 1 s … pool `maxTtl`, else `INVALID_REQUEST`                          |
| `waitTimeoutMs`      | optional; **default 0** (fail fast); capped by `server.maxWait`                |
| `clientRequestId`    | optional idempotency key; the TypeScript client generates one                  |
| `purpose`, `context` | optional, shown in diagnostics/evidence; never put secrets here                |

## AcquireResponse / LeaseView

```json
{
  "lease": {
    "leaseId": "lease_x7…",
    "resourceId": "buyer-01",
    "pool": "premium-buyers",
    "owner": "gha-483-1/chromium/worker-2",
    "principal": "ci",
    "resource": {
      "id": "buyer-01",
      "pool": "premium-buyers",
      "tags": { "region": "nl", "paymentMethod": "ideal" },
      "metadata": { "email": "buyer01@example.test" },
      "secretKeys": ["password"]
    },
    "state": "ACTIVE",
    "ttlMs": 600000,
    "createdAt": 1789476753247,
    "expiresAt": 1789477353247,
    "lastHeartbeatAt": 1789476753247,
    "clientRequestId": "…",
    "purpose": "…"
  },
  "reused": false,
  "waitedMs": 0
}
```

`lease.resource` is the **snapshot** taken at acquisition; it does not change if the configuration
changes while the lease is active. Ended leases add `endedAt` and `endReason`
(`RELEASED | QUARANTINED | EXPIRED | FORCE_RELEASED`). Timestamps are epoch milliseconds from the
server clock.

## Release outcomes

`outcome` is `released`, `already_released` or `already_expired`. All three are HTTP 200: release
is idempotent.

## Error codes

| Code                                                                                       | Status | Meaning                                                       |
| ------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------- |
| `INVALID_REQUEST`                                                                          | 400    | schema violation; `details.issues[]` lists paths              |
| `UNAUTHORIZED`                                                                             | 401    | missing/invalid token                                         |
| `FORBIDDEN`                                                                                | 403    | token lacks a scope (`details.requiredScope`)                 |
| `LEASE_OWNERSHIP_MISMATCH`                                                                 | 403    | owner or principal differs (`details.mismatch`)               |
| `POOL_NOT_FOUND`, `RESOURCE_NOT_FOUND`, `LEASE_NOT_FOUND`, `NOT_FOUND`                     | 404    |                                                               |
| `NO_MATCHING_RESOURCE`                                                                     | 409    | no resource can ever satisfy the tags (`details.knownValues`) |
| `POOL_EXHAUSTED`                                                                           | 409    | wait = 0 and nothing free; `details` has the pool diagnostic  |
| `ACQUIRE_TIMEOUT`                                                                          | 409    | waited `waitTimeoutMs`; same diagnostic                       |
| `LEASE_EXPIRED`, `LEASE_NOT_ACTIVE`                                                        | 409    | lease ended                                                   |
| `IDEMPOTENCY_CONFLICT`                                                                     | 409    | key bound to an incompatible active lease                     |
| `RESOURCE_QUARANTINED`, `RESOURCE_NOT_QUARANTINED`, `RESOURCE_LEASED`, `RESOURCE_DISABLED` | 409    | state conflicts                                               |
| `SECRET_RESOLUTION_FAILED`                                                                 | 500    | reference could not be resolved on the server                 |
| `SERVER_SHUTTING_DOWN`                                                                     | 503    | retry against the restarted server                            |
| `UNAVAILABLE`                                                                              | 503    | client-side: server unreachable                               |
| `INTERNAL_ERROR`                                                                           | 500    | `details.requestId` for the logs                              |

## Events

`{seq, at, type, pool?, resourceId?, leaseId?, owner?, details?}` with types
`RESOURCE_REGISTERED`, `RESOURCE_UPDATED`, `RESOURCE_DISABLED`, `RESOURCE_ENABLED`,
`LEASE_ACQUIRED`, `LEASE_REUSED`, `LEASE_RENEWED`, `LEASE_RELEASED`, `LEASE_EXPIRED`,
`RESOURCE_QUARANTINED`, `RESOURCE_RESTORED`, `ACQUIRE_TIMEOUT`, `LEASE_SECRETS_RESOLVED`.
`seq` is a global monotonic sequence; for each resource, `LEASE_ACQUIRED` strictly alternates with
`LEASE_RELEASED`/`LEASE_EXPIRED` — the tests use exactly this property to prove no overlap.

## Limits

Body ≤ 64 KB (`server.requestBodyLimitBytes`), ≤32 tags, ≤32 context entries, owner ≤200 chars,
`waitTimeoutMs` ≤ `server.maxWait`, TTL ≤ pool `maxTtl` ≤ 7 days.
