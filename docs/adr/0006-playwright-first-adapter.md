# ADR-0006: Playwright as the first framework adapter

**Status:** Accepted — 2026-09-15

## Context

The value of TestLease shows up in parallel runners. Playwright is the most common one in
the target audience, runs tests in worker processes with a stable `parallelIndex`, and has a
fixture model that maps cleanly onto "acquire before, release after".

## Decision

Ship `@testlease/playwright` with `withTestLease(base, { client, fixtures })`:

- Each configured fixture becomes an exclusive `LeasedResource` (`metadata`, `tags`,
  `secrets`, `quarantine()`, `renew()`).
- **Worker scope** (default): acquired on first use, held for the worker's lifetime, heartbeat
  automatic, released in worker teardown. Owner `run/project/worker-N`.
- **Test scope**: one lease per test, released in the test's teardown.
- An **auto fixture** attaches sanitized `testlease.json` evidence to every test and, before a
  test, re-acquires a worker lease that ended (quarantined, expired) so the test never runs on a
  dead resource (`reacquired: true` in evidence).
- A crashed worker never releases; the TTL reclaims the resource. Its replacement takes over the
  still-active lease through the idempotent `clientRequestId` (ADR-0010).
- Default `waitTimeoutMs` in this adapter is 60 s (unlike the core's 0), because waiting for an
  account is the expected behaviour in a CI worker.

Cypress, WebdriverIO, pytest and others are documented as future adapters; the HTTP API and the
CLI's `testlease exec` already serve them without code.

## Alternatives considered

- **A generic "runner adapter" abstraction first**: premature; one real adapter teaches more
  than three shallow ones.
- **Global setup acquiring N accounts and distributing them by index**: no per-worker
  heartbeat, no TTL recovery per worker, and it breaks when Playwright restarts a worker.

## Consequences

- Playwright's global `workers` setting caps per-project workers; with more workers than
  resources the extra workers wait in fixture setup — documented guidance, not a bug.
- The adapter depends only on `@testlease/client` and `@playwright/test` (peer).
