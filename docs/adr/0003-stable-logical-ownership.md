# ADR-0003: Stable logical owner vs. authenticated principal

**Status:** Accepted — 2026-09-15 (revised during the core review)

## Context

Test runners recycle processes. A Playwright worker that crashes is replaced by a new process
with a new PID but the same *parallel index*; a retried test may run in another worker. If
ownership were tied to a PID or a socket, the replacement could not continue and diagnostics
would show meaningless numbers.

## Decision

A lease records two identities with different purposes:

- **`owner`** — a client-chosen, stable, *logical* identity such as
  `gha-483-1/chromium/worker-2` (run id / project / worker slot) or `…/test-<testId>` for
  test-scoped leases. It is for diagnostics and for protection against *accidental* misuse:
  renew/release/quarantine must present the same owner.
- **`principal`** — the *authenticated* identity derived by the server from the API token
  (token name), or `local` in insecure-local mode. Clients cannot choose it.

Renew, release, quarantine and secret resolution require **principal AND owner** to match.
Administrative overrides (`force`) require the `lease:admin` scope and are recorded with the
acting principal.

Supported scopes: `test` (one lease per test), `worker` (one per worker slot, the Playwright
default) and `manual` (CLI / agents).

## Alternatives considered

- **Process identity (PID, hostname)**: unstable across worker restarts; useless in reports.
- **Lease tokens (capability secrets returned on acquire)**: strongest proof of ownership, but
  they make operator tooling awkward (`testlease release <id>` would need the token) and add a
  secret to every client. Principal + owner gives the same practical protection for an internal
  QA infrastructure without another credential to manage. Can be added later without breaking
  the model.
- **Owner as authorization on its own**: rejected in review — anyone with `lease:write` could
  guess another worker's owner string and release its lease.

## Consequences

- The Playwright adapter derives the owner from run id + project + `parallelIndex`, and uses
  `${owner}#${fixture}` as `clientRequestId`, so a replacement worker *takes over* the still
  active lease of its crashed predecessor instead of waiting for the TTL (ADR-0010).
- Diagnostics can say `owner=gha-483-1/chromium/worker-2` instead of `pid=48213`.
