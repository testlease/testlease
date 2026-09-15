# TestLease

**Stop parallel tests from fighting over shared test accounts and environments.**

Parallel tests become unreliable when workers share scarce accounts, tenants, devices or sandbox
environments. TestLease gives each worker an exclusive, expiring lease and returns the resource
when the work is done — or when the worker disappears.

> A test resource should have an owner, a lease, an expiry and evidence.

```
Playwright worker 1 ──acquire──▶ ┌───────────┐ ──▶ buyer-01  LEASED   owner=gha-483/chromium/worker-1
Playwright worker 2 ──acquire──▶ │ TestLease │ ──▶ buyer-02  LEASED   owner=gha-483/chromium/worker-2
Playwright worker 3 ──acquire──▶ │  (SQLite) │ ──▶ buyer-03  LEASED   owner=gha-483/chromium/worker-3
Playwright worker 4 ──acquire──▶ └───────────┘ ──▶ waiting… (FIFO, 41s, released or expired next)
```

- Atomic leases: never two active owners for one resource, enforced by the database.
- TTL + heartbeat: a crashed worker frees its resource; a slow healthy one keeps it.
- Waiting with fairness and a diagnostic that tells you _who_ holds _what_ and for how long.
- Quarantine: a test that finds a contaminated account takes it out of rotation with a reason.
- Evidence: every lease has an event trail; Playwright tests get a sanitized `testlease.json`.
- Secrets stay on the server (`env:` references). The MCP server never sees secret values.
- Framework-agnostic HTTP API; first-class Playwright fixtures; MCP over stdio and Streamable HTTP.

## Why TestLease

Shared test resources are infrastructure, but they are usually managed like folklore: a
spreadsheet of accounts, `buyer-01` hard-coded in three suites, a Slack message asking "is anyone
using the admin tenant?". Under parallel execution that produces flaky failures that look like
application bugs: two workers change the same cart, a login gets rate-limited, a tenant is
half-migrated by another test.

TestLease treats those resources like infrastructure: they live in a pool, a worker leases exactly
one, the lease expires unless renewed, and everything that happened to the resource is recorded.

## Quick start

Configuration (`testlease.yml`):

```yaml
pools:
  premium-buyers:
    defaultTtl: 10m # a dead worker blocks an account for at most 10 minutes
    resources:
      - id: buyer-01
        tags: { region: nl, paymentMethod: ideal } # matching surface
        metadata: { email: buyer01@example.test } # public, informational
        secrets: { password: env:BUYER_01_PASSWORD } # reference, resolved on the server
      - id: buyer-02
        tags: { region: nl, paymentMethod: card }
        metadata: { email: buyer02@example.test }
        secrets: { password: env:BUYER_02_PASSWORD }
```

Run the server (local, no auth, bound to `127.0.0.1`):

```bash
export BUYER_01_PASSWORD=… BUYER_02_PASSWORD=…
npx testlease serve --config testlease.yml
```

or with Docker (binds `0.0.0.0`, therefore a token is required):

```bash
docker run -p 4747:4747 \
  -e TESTLEASE_TOKEN=change-me-at-least-16-chars \
  -e BUYER_01_PASSWORD=… -e BUYER_02_PASSWORD=… \
  -v ./testlease.yml:/app/testlease.yml -v testlease-data:/data \
  ghcr.io/testlease/testlease
```

Lease a resource from TypeScript:

```ts
import { TestLeaseClient } from '@testlease/client';

const client = new TestLeaseClient({
  baseUrl: 'http://127.0.0.1:4747',
  owner: 'ci-job-483/worker-2',
});

const lease = await client.acquireLease({
  pool: 'premium-buyers',
  tags: { region: 'nl', paymentMethod: 'ideal' },
  waitTimeoutMs: 60_000, // wait for a free account instead of failing
});
console.log(lease.metadata.email); // buyer01@example.test
const password = await lease.secret('password'); // requires the secrets:resolve scope
// … run the test; the heartbeat keeps the lease alive …
await lease.release();
```

Only one owner holds `buyer-01` at a time. If the process dies, the lease expires after the TTL.
If another worker needs an account, it waits up to its deadline rather than stealing one.

Look at the state from a terminal:

```
$ testlease status
POOL              AVAILABLE   LEASED   QUARANTINED   TOTAL   WAITING
premium-buyers    1           1        0             2       0

$ testlease inspect premium-buyers
premium-buyers
  defaultTtl=10m  maxTtl=1h  available=1  leased=1  quarantined=0  disabled=0  waiting=0

  RESOURCE   STATE       TAGS                           OWNER                 EXPIRES     NOTE
  buyer-01   LEASED      region=nl,paymentMethod=ideal  ci-job-483/worker-2   in 09:31
  buyer-02   AVAILABLE   region=nl,paymentMethod=card
```

Any language can do the same over HTTP; for command-line runners there is
`testlease exec --pool premium-buyers -- pytest tests/checkout` which acquires, heartbeats, injects
`TESTLEASE_*` variables (including secrets, never on the command line) and releases when the
command exits.

## How leasing works

```
Playwright Worker            TestLease                       SQLite
      |                          |                              |
      | POST /v1/leases/acquire  |                              |
      |------------------------->| BEGIN IMMEDIATE              |
      |                          |----------------------------->|
      |                          | expire overdue leases        |
      |                          | pick AVAILABLE resource      |
      |                          | INSERT lease (ACTIVE)        |  <- UNIQUE(resource_id) WHERE state='ACTIVE'
      |                          | UPDATE resource -> LEASED    |  <- WHERE state='AVAILABLE', changes must be 1
      |                          | INSERT event LEASE_ACQUIRED  |
      |                          | COMMIT                       |
      |<-------------------------| lease + resource snapshot    |
      |                          |                              |
      | POST /v1/leases/:id/renew (heartbeat, every TTL/3)      |
      |------------------------->| expires_at = now + ttl       |
      |                          |----------------------------->|
      |                          |                              |
      | POST /v1/leases/:id/release                             |
      |------------------------->| lease -> RELEASED            |
      |                          | resource -> AVAILABLE        |
      |                          | wake the next FIFO waiter    |
```

- **States.** Resource: `AVAILABLE → LEASED → AVAILABLE`, plus `QUARANTINED` (needs an operator)
  and `DISABLED` (removed from configuration; history kept). Lease: `ACTIVE → RELEASED | EXPIRED`.
- **Atomicity.** Every mutation is one synchronous SQLite transaction. The invariant "one active
  lease per resource" is a unique partial index, not application logic.
- **Matching.** `tags` are the only matching surface; a resource is eligible when it has every
  requested tag. `metadata` is informational. Among eligible resources the least recently leased
  wins (accounts rotate).
- **Waiting.** Unsatisfiable acquisitions join an in-process FIFO queue per pool and are served
  when a resource is released, expires or is restored. A later waiter is served first only if the
  earlier one's tags do not fit the freed resource. A disconnected client is removed from the
  queue, so nobody is assigned a resource they will never use.
- **Expiry.** Evaluated inside every write transaction _and_ by a timer; correctness never depends
  on the timer. Renewing an expired lease fails with `LEASE_EXPIRED`; the resource may already
  have a new owner.
- **Idempotency.** `clientRequestId` (auto-generated by the client) makes a retried acquire return
  the same lease instead of a second one.
- **Ownership.** A lease records a client-chosen logical `owner` (`run/project/worker-N`) _and_ the
  authenticated `principal` (token name). Renew/release require both to match; operators use
  `--force` with the `lease:admin` scope.
- **Snapshot.** The resource contract (tags, metadata, secret references) is frozen per lease.
  Configuration changes affect the _next_ lease, never a running test.

Details: [docs/api.md](docs/api.md), [docs/configuration.md](docs/configuration.md),
[docs/failure-semantics.md](docs/failure-semantics.md) and the [ADRs](docs/adr/README.md).

## Playwright

```ts
// tests/fixtures.ts
import { test as base } from '@playwright/test';
import { withTestLease } from '@testlease/playwright';

export const test = withTestLease(base, {
  client: { baseUrl: process.env.TESTLEASE_URL!, token: process.env.TESTLEASE_TOKEN },
  fixtures: {
    buyer: { pool: 'premium-buyers', scope: 'worker', tags: { region: 'nl' } },
  },
});
```

```ts
test('customer can manage subscription', async ({ page, buyer }) => {
  await login(page, { email: buyer.metadata.email as string, password: buyer.secret('password') });
  // …
  if (accountLooksBroken) await buyer.quarantine('account locked by fraud check');
});
```

The fixture acquires once per worker (owner `run/project/worker-N`), heartbeats, releases in
teardown, replaces a quarantined or expired account before the next test, and attaches a sanitized
`testlease.json` to every test:

```json
{
  "test": { "title": "checkout scenario 3", "status": "failed" },
  "leases": [
    {
      "fixture": "buyer",
      "scope": "worker",
      "leaseId": "lease_…",
      "pool": "premium-buyers",
      "resourceId": "buyer-03",
      "owner": "gha-483-1/chromium/worker-2",
      "principal": "ci",
      "acquiredAt": "…",
      "expiresAt": "…",
      "state": "ACTIVE",
      "expiredDuringUse": false,
      "heartbeat": { "healthy": true, "renewals": 4, "failures": 0 },
      "tookOver": false,
      "reacquired": false,
      "secretsResolved": true
    }
  ]
}
```

With that attachment a failure can be sorted into _application failure_, _test failure_,
_resource collision_ (would show as two leases on one resource — impossible by construction),
_lease expiry_ (`expiredDuringUse: true`) or _resource contamination_ (`quarantineReason`).
TestLease does not guess the root cause; it gives you the evidence.

`examples/playwright` runs 8 workers against 3 accounts and verifies from the event log that no
two workers ever used the same account. See [docs/playwright.md](docs/playwright.md).

## MCP

TestLease is an MCP server, so an agent can coordinate resources the same way a CI worker does:

```
1. testlease_pool_status("premium-buyers")
2. testlease_acquire({ pool, tags, ttlSeconds: 600, waitSeconds: 30, purpose })
3. run the selected tests (a runner with its own token resolves the secrets)
4. testlease_lease_events(leaseId)   # inspect evidence
5. testlease_release(leaseId)
```

- **stdio** (agent host spawns it): `testlease mcp --url http://127.0.0.1:4747`
- **Streamable HTTP** (remote server): `POST http://host:4747/mcp` with a Bearer token

Tools: `testlease_list_pools`, `testlease_pool_status`, `testlease_acquire`, `testlease_get_lease`,
`testlease_renew`, `testlease_release`, `testlease_lease_events`, and — only when the operator
enables it — `testlease_quarantine`. Read-only resources: `testlease://pools`,
`testlease://pools/{pool}`, `testlease://leases/{leaseId}`. Tools carry `readOnlyHint` /
`destructiveHint` / `idempotentHint` annotations.

An acquisition result looks like this — note `availableSecretKeys`, never values:

```json
{
  "leaseId": "lease_…",
  "pool": "premium-buyers",
  "resourceId": "buyer-02",
  "metadata": { "email": "buyer02@example.test" },
  "tags": { "region": "nl" },
  "availableSecretKeys": ["password"],
  "expiresAt": "…",
  "ttlSeconds": 600
}
```

If the agent (or the test it launched) crashes before releasing, the TTL recovers the resource.
See [docs/mcp.md](docs/mcp.md) and [examples/mcp](examples/mcp).

## Secret handling

- Resources declare secrets as **references** (`password: env:BUYER_01_PASSWORD`). SQLite stores
  the reference, never the value. Startup fails with a list of every unresolvable reference.
- Values are resolved on the server only for `POST /v1/leases/:id/secrets` by the lease's
  owner+principal holding the **`secrets:resolve`** scope, and returned to that caller only
  (`lease.secret('password')`, the Playwright fixture, `testlease exec`). The access is recorded
  as a `LEASE_SECRETS_RESOLVED` event (names only).
- Secrets never appear in logs, events, diagnostics, evidence or MCP responses; tests assert this.
- The resolver is an interface (`SecretResolver`); `env:` is the only provider in v0.1. Vault or
  cloud secret managers can be added without touching the leasing domain.

## Crash recovery

A worker that dies stops heartbeating. When its lease's TTL elapses the lease becomes `EXPIRED`
(event `LEASE_EXPIRED` with `lastHeartbeatAt` and `overdueMs`) and the resource is `AVAILABLE`
again; the next waiter is served immediately. A worker that is alive but slow keeps renewing and is
never interrupted — proven with a 1 s TTL and a 300 ms heartbeat for 2.5 s of continuous rival
attempts. A server restart keeps active leases (they are in SQLite) and expires only overdue ones.

## Quarantine

`lease.quarantine('account locked')` (or `testlease quarantine <lease-id> --reason …`) ends the
lease and moves the resource to `QUARANTINED` with the reason and who reported it. It is never
handed out again until `testlease restore <resource-id>` (scope `resource:admin`). Diagnostics and
`testlease inspect` show quarantined resources with their reason, so a timed-out worker can see
why capacity shrank.

## Architecture

```
packages/protocol    wire types, error codes, TestLeaseApi / SecretsApi           (no deps)
packages/core        LeaseService, SQLite store + migrations, config, secrets, events, waiting
packages/server      Hono REST API, Bearer token auth + scopes, graceful shutdown
packages/client      TestLeaseClient + Lease handle (heartbeat, evidence)
packages/cli         testlease: serve · status · inspect · acquire · release · renew · quarantine
                     restore · events · exec · doctor · validate · mcp
packages/playwright  withTestLease fixtures
packages/mcp         MCP server (stdio bridge + Streamable HTTP), secret-free projections
```

Dependency direction: `core` knows nothing about HTTP, Playwright or MCP. Adapters depend on
`client`/`protocol`. REST and the in-process MCP endpoint call the same `LeaseService`; the stdio
MCP bridge talks to the server over HTTP so there is one source of truth
([ADR-0005](docs/adr/0005-mcp-transports.md), [ADR-0008](docs/adr/0008-rest-api-boundary.md)).

Topology contract: **one TestLease server, many clients, one SQLite database**. Multiple processes
writing the same file remain _correct_ (proved by an 8-process test) but do not share the waiting
queue ([ADR-0009](docs/adr/0009-waiting-and-fairness.md)).

## Failure semantics

| Situation                                                      | What happens                                          | Code                            |
| -------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------- |
| No resource in the pool can ever match the tags                | fails immediately, lists known tag values             | `NO_MATCHING_RESOURCE`          |
| Matching resources exist but none is free, `waitTimeoutMs` = 0 | fails immediately with a full pool diagnostic         | `POOL_EXHAUSTED`                |
| Waited the whole `waitTimeoutMs`                               | fails with the diagnostic and records an event        | `ACQUIRE_TIMEOUT`               |
| Client disconnects while waiting                               | waiter removed; no lease is created for it            | `ACQUIRE_ABORTED` (server side) |
| Retry after a lost response                                    | same `clientRequestId` → same lease, `reused: true`   | —                               |
| Same `clientRequestId`, different pool/tags/owner              | refused                                               | `IDEMPOTENCY_CONFLICT`          |
| Renew or release after expiry                                  | refused; resource may have a new owner                | `LEASE_EXPIRED`                 |
| Release twice                                                  | second call succeeds with `outcome: already_released` | —                               |
| Wrong owner or wrong token for a lease                         | refused unless `force` + `lease:admin`                | `LEASE_OWNERSHIP_MISMATCH`      |
| TTL above the pool maximum                                     | refused, never silently clamped                       | `INVALID_REQUEST`               |
| Server shutting down                                           | waiters fail, active leases are kept                  | `SERVER_SHUTTING_DOWN`          |
| Server unreachable (client)                                    | clear message with `testlease doctor` hint            | `UNAVAILABLE`                   |

All errors are `{ "error": { "code", "message", "details" } }`; switch on `code`.

## Security model

- Default bind `127.0.0.1` without tokens (`insecure-local` mode, principal `local`). Binding any
  other address **requires** tokens or an explicit, loudly logged `allowInsecureRemote`.
- Tokens (`auth.tokens` with `env:` references, or `TESTLEASE_TOKEN`) are compared as SHA-256
  digests with constant-time comparison and never logged. Scopes: `lease:read`, `lease:write`,
  `lease:admin`, `pool:read`, `resource:admin`, `secrets:resolve`. Default token scopes exclude
  `lease:admin`, `resource:admin` and `secrets:resolve`.
- Ownership = principal + owner (see above). `force` needs `lease:admin`.
- MCP identities cannot resolve secrets structurally: the MCP adapter is typed against an API
  without that method and every result passes an allow-list projection.
- Request body limit (64 KB), input validation with stable error codes, per-request wait cap
  (`server.maxWait`), Host/Origin validation on `/mcp`.
- `testlease exec` puts secrets in the child's environment only and redacts them from its output
  (best effort; see [docs/exec.md](docs/exec.md) for the trust boundary).

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Verified results (v0.1.0)

Everything below was run for real on the reference machine (macOS, Node 22.14) — numbers are from
those runs, not projections. CI repeats them on Linux with Node 22 and 24.

| Claim                                                  | Evidence                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two concurrent clients cannot obtain the same resource | 50 concurrent in-process acquirers on 5 resources: max 5 holders, 0 overlaps, event log alternates strictly (226 ms); 8 OS processes × 150 attempts on one SQLite file: 858 acquisitions, 342 denials, 0 overlaps, 0 ownership losses              |
| …over HTTP                                             | 50 independent HTTP clients, 5 resources, waiting enabled: 50 acquisitions, 0 overlap, 0 leaked waiters (352 ms)                                                                                                                                   |
| Pool exhaustion causes waiting rather than collision   | ≥40 of the 50 acquisitions above waited; FIFO order asserted; tag-incompatible waiters skipped correctly                                                                                                                                           |
| Client cancellation leaves no ghost lease              | 10 waiters, 7 aborted, exactly the 3 live ones served                                                                                                                                                                                              |
| TTL recovers an abandoned lease                        | 1 s TTL, no heartbeat → `EXPIRED`, resource `AVAILABLE`; SIGKILLed Playwright worker → lease never `RELEASED`, expired after its 3 s TTL                                                                                                           |
| Heartbeat keeps a legitimate lease alive               | 1 s TTL, 300 ms heartbeat, 2.5 s of rival attempts: all denied, lease still `ACTIVE`                                                                                                                                                               |
| Quarantined resource is not handed out                 | 40 concurrent acquisitions never received the quarantined resource; after restore it was handed out again                                                                                                                                          |
| Restart does not erase active leases                   | file DB, restart with the clock advanced: live lease `ACTIVE`, overdue lease `EXPIRED`, quarantine kept; graceful shutdown fails waiters with 503                                                                                                  |
| Same request ID → one lease                            | 10 concurrent identical requests: 1 `LEASE_ACQUIRED`, 9 `LEASE_REUSED`                                                                                                                                                                             |
| Playwright: multiple workers vs fewer resources        | 8 workers, 3 accounts, 24 tests (real Chromium): 24 passed, 8 worker leases, 5 waited (longest 2.6 s), 0 overlap in both the tests' usage log and the server's event log, all accounts returned; every test has a `testlease.json` without secrets |
| CLI can inspect the resulting state                    | end-to-end tests spawn the built binary: `status`, `inspect`, `events`, `acquire`, `release` (with ownership hints), `exec` (redaction), `doctor`, `validate`                                                                                      |
| MCP works over stdio and Streamable HTTP               | real MCP clients: list/inspect/acquire/get/renew/events/release + resources over both transports; abandoned sessions recovered by TTL                                                                                                              |
| No MCP response contains secret values                 | every tool result, resource and error text scanned for the configured secret values _and_ references                                                                                                                                               |
| Deterministic CI checks                                | format, lint (type-aware), typecheck, build, package validation, 5 test projects, coverage thresholds (statements 88 %, branches 76 %, functions 88 %, lines 90 % on in-process code), Docker smoke test                                           |

Docker: the image definition was validated by building the same production bundle locally
(`pnpm deploy`) and running it; the container build itself runs in CI.

## Known limitations

- One server per SQLite database. No cross-server fairness, no HA.
- Waiting is bounded by `server.maxWait` (10 min default) per request; clients may loop.
- `LEASE_RENEWED` events are recorded for every heartbeat; at TTL/3 intervals this is small,
  but a very short TTL on many resources grows the event table quickly. No event retention job yet.
- Configuration is read at startup; changing pools requires a restart (active leases survive it).
- `testlease exec` redaction is best effort (exact-value substring replacement).
- Only the `env:` secret provider exists.
- Playwright's global `workers` setting caps per-project workers; with more workers than resources
  the extra workers wait inside fixture setup and Playwright does not rebalance their tests.
- Docker image build was not executed on the reference machine (no Docker available); it is
  exercised in CI.

## Roadmap

- v0.2: event retention/compaction, `testlease leases` listing with filters, PostgreSQL store
  behind the existing store interface (only if SQLite proves limiting), Vault/AWS secret
  resolvers, hot configuration reload, per-pool acquisition metrics (`/metrics`, small).
- Later: Cypress / WebdriverIO / pytest adapters (the HTTP recipe is in
  [docs/adapters.md](docs/adapters.md)), lease tokens as an optional stronger ownership proof.

Out of scope on purpose: dashboards, SaaS, billing, Kubernetes operators, multi-region consensus,
AI failure diagnosis, dynamic account creation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Decisions are recorded in [docs/adr](docs/adr/README.md).
Licensed under [Apache-2.0](LICENSE): permissive, patent-grant included, familiar to companies that
will run this next to their credentials.
