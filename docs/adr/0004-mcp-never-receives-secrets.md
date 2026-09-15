# ADR-0004: MCP never receives secret values

**Status:** Accepted — 2026-09-15

## Context

An AI agent coordinating test runs needs to know *which* account it holds and *that* a
password exists for it. It does not need the password: the test runner it launches resolves
credentials with its own authorized token. Anything returned to a model ends up in prompts,
logs and transcripts.

## Decision

- The MCP adapter is typed against `TestLeaseApi`, which **has no secret-resolution method**.
  `SecretsApi` is a separate interface implemented only by the HTTP client and the in-process
  API; the MCP package cannot call it without a cast.
- Every MCP result passes through **allow-list projections** (`sanitize.ts`) that copy named
  fields only. They expose `availableSecretKeys` (names) and drop even secret *references*
  (`env:BUYER_01_PASSWORD`).
- MCP identities never receive the `secrets:resolve` scope by default, and the MCP endpoint
  has no route that would use it.
- Dangerous administrative operations (`force` release, resource quarantine/restore, anything
  that lists all leases) are not MCP tools. Lease-level `testlease_quarantine` exists only when
  the operator enables it (`mcp.allowQuarantine` / `--allow-quarantine`) and is annotated
  `destructiveHint: true`.
- Tests connect a real MCP client over both transports and scan every response, resource and
  error text for configured secret values and references.

## Alternatives considered

- **Return secrets when the token allows it**: convenient, but it turns a prompt into a
  credential store. The runner already has a better path (`lease.secrets()` / `testlease exec`).
- **Redact by pattern**: fragile; allow-lists fail closed.

## Consequences

- Agents orchestrate (status → acquire → run → release); runners authenticate. Two tokens with
  different scopes make this explicit.
- Accidental secret disclosure through MCP is treated as a security bug (see SECURITY.md).
