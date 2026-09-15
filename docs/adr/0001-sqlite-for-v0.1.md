# ADR-0001: SQLite (better-sqlite3) as the only store for v0.1

**Status:** Accepted — 2026-09-15

## Context

TestLease must guarantee that no resource ever has two active leases, survive restarts, and be
trivial to run: `docker run` or `npx testlease serve`, no external infrastructure. Typical
workloads are tens of resources and tens of workers, not thousands of operations per second.

## Decision

Persist everything in a single SQLite file, accessed through `better-sqlite3`:

- **WAL mode**, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5s`.
- Every mutation runs in **`BEGIN IMMEDIATE … COMMIT`** through a synchronous API, so an
  acquisition is one indivisible unit both inside the process and across processes.
- The invariant "one active lease per resource" is enforced by the database itself:
  `CREATE UNIQUE INDEX leases_one_active_per_resource ON leases(resource_id) WHERE state='ACTIVE'`,
  plus a conditional `UPDATE resources … WHERE state='AVAILABLE'` whose `changes()` must be 1.
- `STRICT` tables and `CHECK` constraints tie the denormalised resource state to the lease table.
- Migrations are append-only TypeScript modules applied in a transaction and recorded in
  `schema_migrations`.

## Alternatives considered

- **`node:sqlite`** (built-in): no native dependency, but still marked experimental on Node 22
  and prints a warning on every CLI invocation. Revisit when it is stable.
- **PostgreSQL**: real multi-server story, but it makes the quick start a two-service deployment.
  The storage layer (`SqliteStore`) is the only place SQL lives, so a Postgres store can be added
  behind the same interface if a user actually hits SQLite's limits.
- **Redis / etcd**: distributed locks without evidence history, and infrastructure the target
  users do not want to run for test accounts.
- **In-memory only**: unacceptable; a restart would forget who owns what.

## Consequences

- One server process per database file (see ADR-0009). Several processes _can_ write safely
  (proved by the multi-process test), but waiting and fairness live in one process.
- `better-sqlite3` ships prebuilt binaries for Linux (glibc and musl), macOS and Windows on
  Node 22/24, so no compiler is needed; pnpm must not run its `node-gyp` fallback
  (`pnpm.ignoredBuiltDependencies`).
- Backups are a file copy while the server is stopped, or `sqlite3 .backup` while running.
