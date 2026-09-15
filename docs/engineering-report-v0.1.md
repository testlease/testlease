# Engineering report — TestLease v0.1.0 (2026-09-15)

A factual account of what was built, what was actually run, and what is left.

## What was built

| Package                 | Contents                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@testlease/protocol`   | wire types, 24 stable error codes, `TestLeaseApi` / `SecretsApi` (separate on purpose)                                                                                                                                                                                                                                                                                                                                        |
| `@testlease/core`       | YAML config schema + validation, `env:` secret resolver behind an interface, SQLite store (WAL, `BEGIN IMMEDIATE`, STRICT tables, partial unique indexes), append-only migrations, `LeaseService` (atomic acquire, FIFO waiting with abort, TTL expiry in every write transaction + timer, renew/release/quarantine/restore, idempotency, per-lease resource snapshot), config sync, evidence events, acquisition diagnostics |
| `@testlease/server`     | Hono REST API `/v1`, Bearer tokens (SHA-256 + `timingSafeEqual`), scopes, principal derivation, `force` gating, body limits, request logging, disconnect → waiter removal, graceful shutdown that keeps leases, refusal of unauthenticated non-loopback binds                                                                                                                                                                 |
| `@testlease/client`     | `TestLeaseClient` (auto `clientRequestId`, connection retries, `UNAVAILABLE` hints) and `Lease` handle (unref'd heartbeat, release/quarantine, `secret()`, sanitized evidence)                                                                                                                                                                                                                                                |
| `testlease` (CLI)       | `serve`, `validate`, `doctor`, `pools`, `status`, `inspect`, `lease`, `resource`, `events`, `whoami`, `acquire`, `renew`, `release`, `quarantine`, `quarantine-resource`, `restore`, `exec` (secrets in env, output redaction), `mcp` (stdio bridge)                                                                                                                                                                          |
| `@testlease/playwright` | `withTestLease` worker/test-scoped fixtures, heartbeat, release, quarantine → replacement, takeover after worker restart, `testlease.json` evidence                                                                                                                                                                                                                                                                           |
| `@testlease/mcp`        | MCP server on the official SDK v2 (spec 2026-07-28): 7 tools (+1 opt-in), 3 resources, annotations, stdio bridge, Streamable HTTP handler with per-token sessions and port-agnostic Host/Origin validation, allow-list projections                                                                                                                                                                                            |
| Ops & OSS               | Dockerfile (alpine, `pnpm deploy`, tini, non-root, healthcheck), compose, CI (format/lint/typecheck/build/package validation, Node 22+24 matrix, 5 test projects, coverage thresholds, Docker smoke test), release workflow gated on changesets, Apache-2.0, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, issue/PR templates, Dependabot, 12 ADRs, README + 7 docs, 3 example projects                                            |

## What tests actually ran (reference machine: macOS, Node 22.14, pnpm 10.26)

`pnpm build && pnpm test` — **115 tests in 14 files, all passing, 8.8 s**:

| Vitest project | Tests | What it exercises                                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit           | 71    | duration parsing, config validation, migrations + DB constraints, secret resolver, lease state machine (32 cases), waiting/fairness, config sync, resource snapshot, CLI redactor, client `Lease` handle with a fake client                                                                                                                                                               |
| concurrency    | 12    | 50 concurrent acquirers / 5 resources; 200 synchronous `tryAcquire`; 10× same `clientRequestId`; retry while waiting; 10× concurrent release; crash recovery (real clock); healthy heartbeat (real clock); expiry without sweeper; quarantine under 40 concurrent acquirers; restart with file DB; 30 actors × 3 rounds on one resource; 8 OS processes × 150 attempts on one SQLite file |
| integration    | 22    | REST API in insecure-local and token modes (15), CLI end-to-end against a CLI-started server (7)                                                                                                                                                                                                                                                                                          |
| mcp            | 6     | real MCP clients over stdio (bridge process) and Streamable HTTP                                                                                                                                                                                                                                                                                                                          |
| playwright     | 4     | real `playwright test` runs with Chromium headless shell 1243                                                                                                                                                                                                                                                                                                                             |

Also run: coverage (`statements 88.16 %`, `branches 75.97 %`, `functions 88.10 %`, `lines 89.84 %`
over in-process source; thresholds 80/70/80/80 and stricter domain thresholds pass), `pnpm lint`,
`pnpm typecheck`, `pnpm format:check`, `scripts/check-packages.mjs` (7/7), `pnpm deploy` of the
CLI package and a smoke run of the deployed binary, the `examples/playwright` demo.

## Real concurrency results

- **50 concurrent in-process acquisitions, 5 resources:** max 5 simultaneous holders, 0 overlaps at
  application level, event log alternates strictly per resource, ≥40 waited; 226 ms.
- **8 processes × 150 attempts on one SQLite file (built package):** 858 acquisitions, 342 denials,
  0 overlaps, 0 ownership losses, integrity check clean; 1.1 s.
- **50 independent HTTP clients, 5 resources, waiting:** 50 acquisitions, 0 overlap, 0 leaked
  waiters, ≥40 waited; 352 ms.
- **Cancellation:** 10 HTTP waiters, 7 aborted mid-wait, exactly the 3 live ones received leases,
  0 ghost leases.
- **TTL vs heartbeat:** 1 s TTL — unheartbeated lease expired and its resource was reclaimed;
  300 ms heartbeat kept a lease alive through 2.5 s of continuous rival attempts (all denied).
- **Restart:** live lease `ACTIVE`, overdue lease `EXPIRED`, quarantine kept; graceful shutdown
  rejected a waiter with `SERVER_SHUTTING_DOWN` and the same owner+principal renewed/released after
  the restart.

## Real MCP results

- stdio: `StdioClientTransport` spawned `testlease mcp --url …`; `listTools` returned exactly the 7
  expected tools with correct `readOnlyHint`/`destructiveHint`; full workflow
  (list → status → acquire → idempotent retry → get → renew → events → resources → error cases →
  release → idempotent release) passed; every response scanned for 3 secret values and 4 secret
  reference strings — none found. Abandoned bridge: lease expired after its 1 s TTL.
- Streamable HTTP: same workflow as principal `agent`; unauthenticated `initialize` → 401;
  another token presenting the session id → 403; another principal's release →
  `LEASE_OWNERSHIP_MISMATCH`; `terminateSession` did not release (TTL did); `testlease_quarantine`
  present only with `allowQuarantine` and annotated destructive.

## Real Playwright results

- **8 workers, 3 accounts, 24 tests** (adapter suite): 24 passed; usage log and event log both
  show 0 overlapping use; 8 worker leases, ≥5 waited; 0 expirations; all accounts returned; 24
  `testlease.json` attachments with no secret value or reference; all 8 workers seen.
- **Dogfooding demo** (`examples/playwright`, `pnpm demo`): 24 passed in 6.4 s, 8 leases, 5 waited
  (longest 2.6 s), 0 overlap, 0 leased/waiting after the run.
- **Killed worker:** `SIGKILL` inside a test; lease never `RELEASED`; `EXPIRED` after its 3 s TTL;
  resource `AVAILABLE`.
- **Quarantine:** test 1 quarantined its account; test 2 in the same worker ran on a different
  account with `reacquired: true` in evidence; pool showed 1 quarantined.
- **Test scope:** 6 tests, 4 workers, 2 resources: 6 acquire + 6 release events.

## Bugs discovered during implementation (all fixed, all with regression tests)

1. **Secret leak in `testlease exec` redaction.** The stream transform held back the _raw_ tail
   before redacting, so a secret straddling two chunks was emitted in clear. Found by the CLI e2e
   assertion; reproduced manually; fixed by redacting the buffered text first. Regression:
   `packages/cli/test/unit/redactor.test.ts` (exact chunk sequence).
2. **Event ordering.** `RESOURCE_DISABLED` was recorded before `LEASE_RELEASED` when a
   removed-from-config resource's lease ended. Reordered; the sync test asserts the sequence.
3. **MCP Host validation.** The SDK transport's `allowedHosts` compared the full `Host` header
   including the port, rejecting every request to a random-port server. Replaced with
   port-agnostic Host/Origin validation in the handler (mirrors the official Hono middleware).
4. **Playwright fixture typing.** `F extends Record<string, LeaseFixtureConfig>` let TypeScript
   infer an index signature for fixture literals containing `cond ? {…} : {}`, making every
   fixture `LeasedResource | undefined`. Fixed with a homomorphic constraint.
5. **Playwright fixture signature.** A lint-driven rename of `({}, use, info)` to `(_args, …)`
   made Playwright reject the fixture at load time ("First argument must use the object
   destructuring pattern"). Restored with a documented lint exception.
6. **Tooling:** listing `better-sqlite3` in pnpm's `onlyBuiltDependencies` triggered a
   from-source `node-gyp` build (the package ships prebuilds and has no install script);
   `ignoredBuiltDependencies` fixed it. Playwright's global `workers` default (50 % of cores)
   silently capped the per-project `workers: 8` to 5 in the adapter test config.

No race condition was found in the leasing engine itself in any run.

## Remaining limitations

- One server per SQLite database; no cross-server fairness or HA.
- Configuration changes require a restart (leases survive it).
- Every heartbeat writes a `LEASE_RENEWED` event; no retention/compaction job yet.
- `exec` redaction is exact-substring only (documented trust boundary).
- Only the `env:` secret provider.
- The Docker image was not built on the reference machine (no Docker); the production bundle it
  contains was validated with `pnpm deploy`. GitHub Actions built the image on ubuntu and its
  smoke test passed (`/healthz` ok, `/v1/pools` 401 without token, 200 with token).
- Coverage numbers cover in-process code; the CLI and the Playwright adapter run in child
  processes and are verified end to end but not measured.

## First CI run on GitHub (2026-09-15, `cozgur/testlease`, private)

All seven jobs green on Linux after two fixes that a fresh clone needed: type-aware lint and the
root typecheck ran before `pnpm build`, so `@testlease/*` imports in test files resolved to
not-yet-built `dist/*.d.ts` (fixed with `paths` to source in the root tsconfig) and the Playwright
fixture project, which imports `dist` on purpose, is excluded from the root typecheck. Jobs:
format/lint/typecheck/build/package validation; unit + concurrency on Node 22 and Node 24;
HTTP integration + CLI e2e + MCP; Playwright with real Chromium plus the dogfooding demo;
coverage thresholds; Docker build + smoke test. Dependabot opened six action/base-image bump PRs. Its npm
ecosystem run fails on Dependabot's side: it parses our pnpm constraint (`>=10 <11`, plus
`packageManager: pnpm@10.26.0`) but still installs pnpm 11.17 and its helper subprocess crashes
while processing `typescript`, `rimraf` and `@types/node`. Actions and Docker updates work.
Left enabled so the failure stays visible; Renovate is the fallback if it persists.

The repository was then transferred to the `testlease` organization (`testlease/testlease`,
still private); org and repository settings were changed to allow GitHub Actions to create pull
requests so the changesets release PR can be opened.

## Release 0.1.0 (2026-09-15)

- Repository made public; `testlease/testlease` receives the changesets release flow.
- npm: `testlease@0.1.0` and the six `@testlease/*@0.1.0` packages published from the Release
  workflow with provenance. Verified from a clean directory: `npx testlease@0.1.0 serve`,
  `status` and `acquire` against the published CLI work end to end.
- GitHub Release `testlease@0.1.0` created from the generated changelog; tags for all seven
  packages pushed.
- Docker: `ghcr.io/testlease/testlease:0.1.0` and `:latest` published for linux/amd64 and
  linux/arm64 through the workflow's manual dispatch. The package is created **private** by GHCR
  and must be switched to public in the org's package settings (no API for that).
- Two release-automation findings: (1) `setup-node`'s `registry-url` writes an `.npmrc` that
  reads `NODE_AUTH_TOKEN`; passing only `NPM_TOKEN` made npm publish unauthenticated and the
  registry answered `E404` for the scoped packages — fixed by passing both. (2) `changesets/action@v1`
  does not recognise the changesets v3 CLI output, so it created the release tags locally but did
  not push them or create GitHub releases; and a push of more than three tags at once does not
  trigger `on: push: tags`. `changesets/action@v2` (Dependabot PR #4, merged) is the intended fix; it renamed its inputs
  (`publish-script`, `pr-title`, `commit-message`, `github-token`), which the workflow now uses. The
  Docker job can also be dispatched manually with `image_version`.

## v0.2.0 (2026-09-15) — operate without restarts, survive them

Built after an honest self-review of v0.1 (see the "Remaining limitations" above); scope kept to
the items with the highest value/risk ratio.

| Change                                                                                                                                                          | Evidence                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client retries acquisitions through `SERVER_SHUTTING_DOWN` and connection failures within the caller's wait budget, same `clientRequestId`                      | reproduction script and integration test: waiter gets 503, two `ECONNREFUSED`, re-queues on the restarted server (same port) and receives the lease once the holder releases; Playwright runs inherit this |
| Monotonic server clock (`MonotonicClock`), `wallClockDriftMs` in `/healthz`                                                                                     | unit test: ±1–2 h wall-clock jumps do not move `now()`                                                                                                                                                     |
| Configuration reload (`SIGHUP`, `testlease reload`, `POST /v1/config/reload`), tokens included, invalid files rejected                                          | core + HTTP + CLI tests: new resource served to an existing waiter, new token usable, duplicate-id file rejected with `CONFIG_INVALID`, `server.port` change reported as a warning                         |
| Pool allow-list on tokens (`pools: [...]`) enforced in the in-process API (REST and MCP alike)                                                                  | core + HTTP tests: FORBIDDEN by pool name and through lease/resource ids; `whoami.pools`                                                                                                                   |
| Heartbeats counted on the lease (`renewCount`), `LEASE_RENEWED` only on TTL change or opt-in; history retention (30 d) for events and ended leases; migration 2 | unit tests incl. v1→v2 upgrade of a populated database and a month of renewals on a lease that must not be pruned                                                                                          |
| `GET /v1/leases` + `testlease leases`, `GET /metrics` (Prometheus text), `GET /openapi.json`                                                                    | HTTP tests; a test asserts every registered route is documented and vice versa                                                                                                                             |
| `examples/pytest`: stdlib-only Python client + session fixture                                                                                                  | run locally with pytest-xdist (`-n 4`): each worker held exactly one account; CI job added                                                                                                                 |

Totals after v0.2: **129 tests in 16 files, all passing (9.2 s)**; lint, typecheck, format clean;
coverage thresholds unchanged and passing.

Findings while building v0.2: exact-text patching after Prettier reformatting silently failed
twice more (the `acquire` retry deadline and the `whoami` pool list were not applied until a
reproduction showed three attempts and a missing field). Patches are now anchored on exact
current text and asserted. The v0.1 test that expected a waiter to die with `SERVER_SHUTTING_DOWN`
on restart was updated: the client now retries, and with the server returning on another port the
truthful final error is `UNAVAILABLE`.

## Deferred to v0.3

Optional per-lease tokens (ADR-0014), PostgreSQL store (only on evidence of need), Vault/AWS
resolvers, Cypress/WebdriverIO adapters, chunked long-polls for proxy environments.

## Postponed to v0.2 (original list, kept for the record)

Event retention, `testlease leases` listing/filtering, hot config reload, PostgreSQL store behind
the existing store interface (only on evidence of need), Vault/AWS resolvers, small `/metrics`,
additional framework adapters (Cypress, WebdriverIO, pytest) built on `docs/adapters.md`, optional
lease tokens as a stronger ownership proof, npm/Docker publishing (requires explicit authorization).
