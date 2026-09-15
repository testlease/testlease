# Architecture Decision Records

Concise records of the decisions that shape TestLease. Each ADR states the context, the
decision, the alternatives that were considered and the consequences we accept. When a later
decision changes an earlier one, the earlier ADR is marked *superseded* rather than edited.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-sqlite-for-v0.1.md) | SQLite (better-sqlite3) as the only store for v0.1 | Accepted |
| [0002](0002-ttl-heartbeat-lease-model.md) | TTL + heartbeat lease model; shutdown never releases | Accepted |
| [0003](0003-stable-logical-ownership.md) | Stable logical owner vs. authenticated principal | Accepted |
| [0004](0004-mcp-never-receives-secrets.md) | MCP never receives secret values | Accepted |
| [0005](0005-mcp-transports.md) | MCP over stdio (bridge) and Streamable HTTP (in-server) | Accepted |
| [0006](0006-playwright-first-adapter.md) | Playwright as the first framework adapter | Accepted |
| [0007](0007-quarantine-lifecycle.md) | Quarantine lifecycle | Accepted |
| [0008](0008-rest-api-boundary.md) | REST API as the framework-neutral boundary | Accepted |
| [0009](0009-waiting-and-fairness.md) | In-process FIFO waiting; one server per database | Accepted |
| [0010](0010-idempotent-acquisition.md) | Idempotent acquisition with `clientRequestId` | Accepted |
| [0011](0011-tags-metadata-snapshot.md) | Tags vs. metadata, and the per-lease resource snapshot | Accepted |
| [0012](0012-toolchain.md) | Toolchain: TypeScript 6, ESM only, `tsc -b`, vitest 5 | Accepted |
