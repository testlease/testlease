# Security Policy

TestLease sits next to real test credentials, so we treat the following as security bugs:

- any path by which a secret **value** is written to logs, events, evidence attachments,
  diagnostics or an MCP response (MCP must only ever see secret _names_),
- a lease being renewed, released or quarantined by a caller whose principal or owner does not
  match without the `lease:admin` scope,
- two active leases on one resource under any sequence of requests,
- authentication bypass, token comparison that is not constant-time, or token values in logs,
- an unauthenticated server reachable from a non-loopback address without the explicit
  `allowInsecureRemote` opt-in.

## Reporting a vulnerability

Please do **not** open a public issue. Email security@testlease.dev with a description and, if
possible, a reproduction. You will get an acknowledgement within 3 working days and a fix or a
mitigation plan within 14 days for confirmed issues. We will credit you in the release notes
unless you prefer otherwise.

## Supported versions

Only the latest minor release line receives security fixes.

## Security model in short

- Secrets are stored as references (`env:NAME`) and resolved on the server only for the active
  lease's owner/principal with the `secrets:resolve` scope (`POST /v1/leases/:id/secrets`).
- Tokens are compared as SHA-256 digests with `crypto.timingSafeEqual`; they are never logged.
- The server binds `127.0.0.1` by default; binding elsewhere requires tokens or an explicit,
  loudly logged override.
- MCP (both transports) is typed against an API that has no secret-resolution method and passes
  every result through allow-list projections. Tests scan every MCP response for configured
  secret values and references.
- `testlease exec` puts secrets only in the child's environment (never in argv) and redacts them
  from the child's stdout/stderr on a best-effort basis; see `docs/exec.md` for the trust boundary.
