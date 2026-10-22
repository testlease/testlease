# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

TestLease: exclusive, expiring leases for shared test resources (accounts, tenants, devices).
pnpm monorepo (Node >= 22.12, pnpm 10), TypeScript, ESM. Packages in `packages/*`, demos in
`examples/*`.

## Commands

```bash
pnpm install
pnpm build                 # tsc -b tsconfig.build.json — REQUIRED before cli/mcp/playwright tests
pnpm typecheck
pnpm lint                  # ESLint, type-aware
pnpm format:check          # Prettier (pnpm format to fix)
pnpm test                  # all vitest projects
pnpm test:unit | test:concurrency | test:integration | test:mcp | test:playwright
pnpm test:coverage         # thresholds in vitest.config.ts (core/src/domain is stricter: 90/80)
node scripts/check-packages.mjs   # package validation (after build), as in CI
```

Single test: `pnpm vitest run --project unit packages/core/test/unit/<file>.test.ts -t "<name>"`.

- In-process tests import workspace packages **from `src`** via aliases in `vitest.config.ts`.
  The CLI integration, MCP stdio and Playwright suites spawn the **built `dist`** and fail with
  "Run pnpm build first" otherwise — rebuild after changing source those suites exercise.
- Playwright suite needs Chromium: `pnpm --filter @testlease/playwright exec playwright install chromium`.
- Test projects map to directories: `packages/*/test/unit`, `packages/core/test/concurrency`,
  `packages/{server,client,cli}/test/integration`, `packages/mcp/test`, `packages/playwright/test`.

## Architecture

```
protocol    wire types, error codes (ErrorCodes/TestLeaseError), TestLeaseApi/AdminApi contract; no deps
core        createTestLease(): config load/reload, SQLite store + migrations, LeaseService,
            wait queue, matching, diagnostics, secret resolver, LocalApi (in-process TestLeaseApi)
server      Hono REST API (/v1/*, /metrics, /openapi.json), Bearer auth + scopes, /mcp endpoint
client      TestLeaseClient + Lease handle (heartbeat at TTL/3, idempotent retries, evidence)
cli         `testlease` binary (serve, status, inspect, exec, doctor, validate, reload, mcp, …)
playwright  withTestLease fixtures (worker/test scope, testlease.json evidence attachment)
mcp         MCP server (stdio bridge over HTTP + Streamable HTTP), secret-free projections
```

- **Dependency direction is strict:** `core` knows nothing about HTTP, Playwright or MCP.
  Adapters depend on `client`/`protocol`, never `core` internals (test helpers excepted).
- REST and in-process MCP call the same `LeaseService`; the stdio MCP bridge talks to the server
  over HTTP so there is one source of truth (ADR-0005, ADR-0008).
- **Correctness lives in SQLite:** every mutation is one synchronous transaction
  (`BEGIN IMMEDIATE`); "one active lease per resource" is a unique partial index. Expiry is
  evaluated inside every write transaction; the timer is only an optimization.
- Waiting is an in-process per-pool FIFO queue (`domain/wait-queue.ts`); multiple processes on one
  DB stay correct but don't share the queue (ADR-0009). Topology: one server, one SQLite DB.
- Lease snapshots freeze tags/metadata/secret refs; config reload affects only the next lease.
- Secrets are `env:` references stored as references only; resolved server-side solely via
  `POST /v1/leases/:id/secrets` with `secrets:resolve` scope. The MCP adapter is typed against an
  API without that method and passes results through allow-list projections (`mcp/src/sanitize.ts`).
- Expiry decisions use the server's injected `Clock` (`core/src/clock.ts`, monotonic per
  ADR-0015), never client clocks — in core domain code take time from the `Clock`, not `Date.now()`.

Decisions are recorded in `docs/adr/` (ADR-0001…0016); API/config/failure semantics in `docs/*.md`.

## Rules (from CONTRIBUTING)

- Code, comments, commits, PRs, docs and changesets: English only, even if the prompt is in another
  language.
- Fix races in the transaction or schema, never with a retry or sleep. Concurrency tests must be
  truly concurrent (`Promise.all`, child processes).
- Never weaken an assertion to make a suite green.
- Anything that could contain a secret gets a test asserting it does not; never log secrets/tokens.
- Errors are `TestLeaseError` with a stable `code`; messages say what to do next.
- Structured logs: object first, message second.
- Migrations (`core/src/db/migrations.ts`) are append-only — never edit an applied one.
- PRs: add a changeset (`pnpm changeset`); add/update an ADR when a decision changes.
- Release: changesets "Version Packages" PR → npm publish → Docker image to GHCR (`release.yml`).
