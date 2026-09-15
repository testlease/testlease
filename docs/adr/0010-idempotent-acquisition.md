# ADR-0010: Idempotent acquisition with `clientRequestId`

**Status:** Accepted — 2026-09-15

## Context

Responses get lost. A client that retries an acquisition after a timeout must not end up owning
two resources with no record of the first.

## Decision

- `acquire` accepts an optional **`clientRequestId`**. The database enforces at most one
  `ACTIVE` lease per id (`UNIQUE INDEX … WHERE state='ACTIVE' AND client_request_id IS NOT NULL`).
- A repeated request returns the existing active lease with `reused: true` and records
  `LEASE_REUSED`, provided pool, owner and principal match and the lease's frozen tag snapshot
  satisfies the requested tags. Otherwise `IDEMPOTENCY_CONFLICT` — never a silent second lease.
- The idempotency window is the **lifetime of the active lease**; after release or expiry the
  id is free again and yields a fresh lease.
- The TypeScript client generates an id when the caller does not supply one, so every retry is
  safe by default.
- Adapters use *meaningful* ids: the Playwright fixture uses `${owner}#${fixture}`, which lets a
  replacement worker take over the lease its crashed predecessor still holds.

## Alternatives considered

- **Server-side request log keyed by id with the full response**: heavier and unnecessary; the
  lease itself is the response.
- **Idempotency only within a short time window**: surprising when a retry arrives after the
  window; lease lifetime is the natural, explainable boundary.

## Consequences

- The idempotency check runs before the "no matching resource" check, so a retry with the
  original tags is served even after a configuration change altered the live resource's tags.
