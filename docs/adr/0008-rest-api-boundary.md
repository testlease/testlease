# ADR-0008: REST API as the framework-neutral boundary

**Status:** Accepted — 2026-09-15

## Context

The lease protocol must work for Playwright, Cypress, JUnit, pytest, Postman, shell scripts and
AI agents. Only one of those is JavaScript.

## Decision

- The contract is a small **versioned JSON-over-HTTP API** (`/v1`) with stable error codes
  (`error.code`), documented in `docs/api.md`. Everything else — TypeScript client, CLI,
  Playwright fixtures, MCP tools — is a thin layer on it.
- The same domain service (`LeaseService`) sits behind the REST routes and behind the in-process
  MCP endpoint, so there is exactly one implementation of leasing behaviour.
- `@testlease/protocol` holds the wire types, error codes and the `TestLeaseApi` interface;
  adapters are written against that interface so they can be tested against the in-process
  engine or the HTTP client interchangeably.
- Security-relevant choices live in the API: `waitTimeoutMs` defaults to 0; TTL above the pool
  maximum is rejected; `force` needs `lease:admin`; secret resolution is a separate scope and a
  separate endpoint (`POST /v1/leases/:id/secrets`).

## Alternatives considered

- **gRPC**: better typing, worse reach from shell scripts and browsers-in-CI.
- **A JavaScript-only library API**: would exclude most of the target audience.
- **A message queue**: adds infrastructure and hides the simple request/response nature of a lease.

## Consequences

- A new adapter needs an HTTP client, an owner string and three calls: acquire, renew, release.
  `docs/adapters.md` describes the recipe; `testlease exec` covers many cases with no code.
- HTTP status codes are a transport detail; clients switch on `error.code`.
