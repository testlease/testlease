# Contributing to TestLease

Thanks for helping make shared test resources boring. This guide covers setup, the test
suites, and what we expect in a pull request.

## Setup

```bash
git clone https://github.com/testlease/testlease.git
cd testlease
pnpm install          # Node >= 22.12, pnpm 10; no compiler needed (prebuilt SQLite)
pnpm build            # tsc -b; several suites exercise the built artifacts on purpose
pnpm test             # every vitest project
```

Playwright adapter tests need a Chromium: `pnpm --filter @testlease/playwright exec playwright install chromium`.

## Repository layout

```
packages/protocol    wire types, error codes, TestLeaseApi (no runtime deps)
packages/core        leasing engine: config, SQLite store, migrations, LeaseService, events
packages/server      Hono REST API, token auth, graceful shutdown
packages/client      TypeScript client + Lease handle (heartbeat, evidence)
packages/cli         `testlease` command (serve, status, acquire, exec, doctor, mcp, ...)
packages/playwright  Playwright fixtures
packages/mcp         MCP server (stdio + Streamable HTTP)
examples/            dogfooding demos
docs/adr             architecture decision records
```

Dependency direction is strict: `core` knows nothing about HTTP, Playwright or MCP; adapters
depend on `client`/`protocol`, never on `core` internals (test helpers excepted).

## Test suites

| Project     | Command                 | What it proves                                                               |
| ----------- | ----------------------- | ---------------------------------------------------------------------------- |
| unit        | `pnpm test:unit`        | domain state machine, config, migrations, redaction                          |
| concurrency | `pnpm test:concurrency` | 50 concurrent acquirers / 5 resources, 8-process SQLite hammer, TTL, restart |
| integration | `pnpm test:integration` | REST API, token auth, HTTP concurrency, cancellation, CLI end to end         |
| mcp         | `pnpm test:mcp`         | real MCP clients over stdio and Streamable HTTP; no secret in any response   |
| playwright  | `pnpm test:playwright`  | real Playwright workers: 8 workers/3 accounts, killed worker, quarantine     |

Rules of thumb:

- A race condition is fixed in the transaction or the schema, never with a retry or a sleep.
- Concurrency tests must be concurrent (`Promise.all`, child processes), not sequential stories.
- Never weaken an assertion to make a suite green; open an issue with the reproduction instead.
- Anything that could contain a secret gets a test asserting it does not.

## Coding standards

- `pnpm lint` (ESLint, type-aware) and `pnpm format:check` (Prettier) must pass.
- Errors are `TestLeaseError` with a stable `code`; messages are for humans and should say
  what to do next.
- Structured logs: object first, message second; never log secret values or tokens.
- Migrations are append-only. Never edit an applied migration.

## Pull requests

1. Add a changeset: `pnpm changeset` (patch/minor/major per package, one line of user-facing text).
2. Update or add an ADR in `docs/adr` when a decision changes; mark superseded ADRs.
3. Fill in the PR template: what changed, how it was verified, whether the wire format changed.
4. Keep PRs focused; refactors separate from behaviour changes.

## Reporting bugs

Use the bug template. For anything security-related, follow `SECURITY.md` instead of opening
a public issue.
