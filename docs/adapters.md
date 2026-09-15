# Writing an adapter (Cypress, WebdriverIO, pytest, JUnit, Newman, …)

TestLease does not know what a test framework is. An adapter is any code that, around a unit of
work, does three HTTP calls with a stable owner string. The Playwright package is one example of
the recipe below; `testlease exec` is a zero-code version for anything that runs as a command.

## The recipe

1. **Choose an owner.** Stable across process restarts of the same logical slot:
   `<run id>/<project or suite>/<worker slot>` (e.g. `gha-483-1/chromium/worker-2`), plus
   `/test-<id>` for per-test leases. Never a PID.
2. **Acquire** with an idempotency key derived from the owner:

   ```http
   POST /v1/leases/acquire
   { "pool": "premium-buyers", "owner": "…", "tags": { "region": "nl" },
     "waitTimeoutMs": 60000, "clientRequestId": "<owner>#buyer" }
   ```

   Handle `ACQUIRE_TIMEOUT` / `POOL_EXHAUSTED` by failing the test with the `message` — it already
   names who holds what. A retry after a network error with the same `clientRequestId` returns the
   same lease (`reused: true`), which also lets a replacement worker take over.

3. **Heartbeat** every `ttlMs / 3` (clamped to 1–60 s): `POST /v1/leases/:id/renew { "owner" }`.
   Stop on `LEASE_EXPIRED` / `LEASE_NOT_ACTIVE` and surface that in the report.
4. **Secrets**, if the runner needs them: `POST /v1/leases/:id/secrets { "owner" }` with a token
   holding `secrets:resolve`. Keep values out of logs and reports.
5. **Release** in teardown: `POST /v1/leases/:id/release { "owner" }`. Idempotent — call it even if
   you are not sure. If the resource turned out to be contaminated, call
   `POST /v1/leases/:id/quarantine { "owner", "reason" }` instead.
6. **Evidence**: attach `{leaseId, pool, resourceId, owner, acquiredAt, expiresAt, releasedAt,
heartbeat health, expiredDuringUse}` to the test report. Nothing else is needed to tell a lease
   expiry from an application failure later.

## Zero-code: `testlease exec`

```bash
testlease exec --pool premium-buyers --tag region=nl --wait 60s -- pytest tests/checkout
```

acquires, heartbeats, runs the command with

```
TESTLEASE_URL, TESTLEASE_LEASE_ID, TESTLEASE_RESOURCE_ID, TESTLEASE_POOL, TESTLEASE_OWNER,
TESTLEASE_EXPIRES_AT, TESTLEASE_TAG_<KEY>, TESTLEASE_META_<KEY>, TESTLEASE_SECRET_<KEY>
```

in its environment, redacts secret values from the child's output, releases on exit and
propagates the exit code. `--lease <id>` attaches to a lease acquired elsewhere (e.g. by an agent).
See `docs/exec.md` for the trust boundary.

## Scope guidance

| Scope  | Use when                                                                            | Owner                                        |
| ------ | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| worker | the runner has long-lived workers (Playwright, WDIO, Cypress with parallel runners) | `run/project/worker-N`                       |
| test   | each test needs a pristine resource, or workers are short-lived                     | `…/test-<id>`                                |
| manual | humans and agents                                                                   | `cli:user@host`, `mcp:<principal>:<session>` |

## Framework notes

- **Cypress**: acquire in a `before()` of the spec (or via a plugin task in `setupNodeEvents` so
  the lease lives in the Node process, not the browser); release in `after()`. Owner = run id +
  parallel group + spec index.
- **WebdriverIO**: `onWorkerStart`/`onWorkerEnd` hooks for worker scope; `beforeTest`/`afterTest`
  for test scope.
- **pytest / JUnit**: a session- or class-scoped fixture / extension using the HTTP API, or simply
  wrap the runner in `testlease exec`.
- **Newman / k6 / shell**: `testlease exec` and read `TESTLEASE_META_*` / `TESTLEASE_SECRET_*`.

Contributions of adapters are welcome; keep them thinner than the engine and reuse the HTTP
contract rather than re-implementing leasing rules.
