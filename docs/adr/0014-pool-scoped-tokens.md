# ADR-0014: Pool-scoped tokens; lease tokens deferred

**Status:** Accepted — 2026-09-15 (v0.2)

## Context

Scopes in v0.1 were global: a token with `lease:write` could acquire from any pool. Teams that
share one TestLease server want the payments team's token to be unable to touch the admin pool,
and the review of v0.1 asked whether lease tokens (a per-lease secret) should replace the
principal + owner model.

## Decision

- Tokens accept an optional **`pools` allow-list**. The identity is then restricted to those pools
  everywhere: pool/resource reads, acquisition, and every lease operation _by id_ (the lease's
  pool is looked up first). Violations are `FORBIDDEN` with `details.allowedPools`; `whoami`
  shows the restriction. Enforcement lives in the in-process API layer, so REST and MCP over HTTP
  behave identically.
- **Lease tokens are deferred.** Principal + owner + pool allow-lists cover the realistic
  threat model of an internal QA infrastructure (accidental cross-team interference) without
  adding a second credential to every client and report. If a multi-tenant deployment ever needs
  proof-of-possession per lease, it can be added as an _optional_ header without changing the
  wire format of existing fields.

## Alternatives considered

- Per-pool tokens only (one token = one pool): simple but forces one token per pool per team.
- Lease tokens now: strongest, but every adapter, the CLI and evidence handling would carry a
  secret, and operator commands (`release <id>`) would need a bypass anyway.

## Consequences

- Recommended layout: one token per team with `pools`, one admin token, one read-only token for
  metrics scrapers, agent tokens without `secrets:resolve`.
