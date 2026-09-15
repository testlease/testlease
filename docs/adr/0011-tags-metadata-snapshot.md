# ADR-0011: Tags vs. metadata, and the per-lease resource snapshot

**Status:** Accepted — 2026-09-15 (from the core review)

## Context

Early on, a resource's public `metadata` doubled as the matching surface. As soon as fields like
`email`, `displayName` or `notes` are added, every one of them silently becomes a query key.
Separately, configuration can change while a lease is active (rotated secret reference, new
tags) and the running test must not have the ground move under it.

## Decision

- **`tags`** (`Record<string,string>`, values coerced to strings) are the *only* matching
  surface. `acquire({ tags })` selects resources whose tags contain every requested pair.
- **`metadata`** (`Record<string, string|number|boolean>`) is informational and public; it is
  returned to clients and shown in diagnostics but never matched.
- **`secrets`** are references (`env:NAME`) resolved on demand by the server; values are never
  stored.
- When a lease is created the engine stores a **snapshot** of the resource contract — tags,
  metadata and secret references — in the lease row. `lease.resource` always returns that
  snapshot; secret resolution for the lease uses the snapshot's references; idempotent retries
  are checked against the snapshot's tags. The next lease sees the new configuration.
- The live resource keeps `enabledInConfig` separate from runtime `state` so "removed from the
  configuration while leased" is representable without a second source of truth.

## Alternatives considered

- **Metadata as tags with a naming convention**: implicit and error-prone.
- **Failing a running lease when its resource config changes**: punishes the test for an
  operator action.
- **Applying config changes to active leases immediately**: rotates a password under a running
  login flow.

## Consequences

- The wire format is fixed before v0.1: `tags`, `metadata`, `secretKeys`, `lease.resource`.
- Lease rows carry a small JSON snapshot; for tens of resources this is negligible.
