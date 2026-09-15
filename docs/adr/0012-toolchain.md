# ADR-0012: Toolchain: TypeScript 6, ESM only, `tsc -b`, vitest 5

**Status:** Accepted — 2026-09-15

## Context

The repository is a pnpm monorepo of seven packages that must build reproducibly, publish to
npm, run in Docker on Node 22/24 and be pleasant to contribute to.

## Decision

- **Node ≥ 22.12** (LTS with `require(esm)`), **pnpm 10** workspaces.
- **TypeScript 6.0.x** (the last JavaScript-based compiler line). TypeScript 7 (Go) is current
  but `typescript-eslint` does not support it yet; the config uses no deprecated options so the
  upgrade is a version bump.
- **ESM only**, emitted by plain **`tsc -b`** with project references — no bundler, readable
  `dist/`, declaration maps for go-to-source.
- **vitest 5** with named projects (`unit`, `concurrency`, `integration`, `mcp`, `playwright`)
  so CI can run the expensive suites separately; V8 coverage with thresholds that are stricter
  for the domain layer.
- **ESLint 10 + typescript-eslint (type-aware) + Prettier**. Fixture projects and examples are
  linted without type information because they import built artifacts.
- **MCP SDK v2** split packages (`@modelcontextprotocol/server`, `/client`), **Hono 4** with
  `@hono/node-server` 2, **zod 4**, **pino 10**, **commander 15**, **better-sqlite3 13**.
- Releases via **Changesets**; publishing requires explicit authorization.

## Alternatives considered

- **tsup/tsdown bundling**: tsdown requires Node ≥ 22.18; bundling hides stack traces and adds
  little for server-side libraries.
- **Biome** for lint+format: faster, but type-aware rules (`no-floating-promises`) matter more in
  a concurrency-heavy codebase.
- **Dual CJS/ESM output**: Node 22 can `require()` ESM; the complexity is no longer worth it.

## Consequences

- Contributors need Node 22+; no Python or C++ toolchain (prebuilt SQLite binaries).
- `pnpm build` must run before the integration, CLI, MCP and Playwright suites (they exercise
  the built artifacts on purpose).
