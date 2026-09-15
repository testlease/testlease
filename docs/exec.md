# `testlease exec` — trust boundary

`testlease exec` exists so that runners which cannot call the API themselves (pytest, JUnit, shell
scripts) still get exclusive resources and credentials without putting secrets on a command line.

```bash
testlease exec --pool premium-buyers --tag region=nl --wait 60s -- npm test
testlease exec --lease lease_ab12… -- ./run-smoke.sh      # attach to an existing lease you own
```

What it does, in order:

1. acquires a lease (or attaches to one owned by the same owner + token) and starts the heartbeat;
2. resolves the lease's secrets with the caller's token (`secrets:resolve`); with `--no-secrets`
   or a token lacking the scope, secrets are simply not injected (a warning is printed);
3. spawns the command with `TESTLEASE_*` variables in its **environment** (never in `argv`);
4. pipes the child's stdout/stderr through a redactor that replaces every occurrence of each
   secret value with `[REDACTED:<name>]` (`--no-redact` disables it);
5. forwards `SIGINT`/`SIGTERM` to the child, waits for it to exit, releases the lease (`--keep`
   to leave it), and exits with the child's exit code.

## What is protected

- Secrets do not appear in `ps`, shell history or CI command logs: they are environment variables
  of the child only.
- Accidental `console.log(password)` in the test output is redacted before it reaches your
  terminal or CI log, as are values split across stdout chunks.
- The lease is released even when the command fails; a crash of `testlease exec` itself leaves
  the lease to the TTL.

## What is _not_ protected

- The child process can read its own environment and write the secret anywhere it likes (a file,
  a network call, `base64`-encoded output). Redaction is exact-substring replacement of the raw
  value; it does not catch encodings, splits across separate write calls into different streams,
  or values shorter than 4 characters.
- Anything with the same OS user can read the child's environment (`/proc/<pid>/environ`).
- Secrets are in memory of `testlease exec` and the child for the duration of the run.

The boundary is therefore: **`testlease exec` keeps secrets out of command lines and out of
ordinary logs; it does not protect against code that deliberately exfiltrates them.** Use tokens
without `secrets:resolve` for anything that does not need credentials (agents, read-only tooling).
