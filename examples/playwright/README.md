# Playwright dogfooding demo

Eight Playwright workers, three shared premium-buyer accounts, twenty-four tests. Without
TestLease the workers would log into the same accounts at the same time and trip over each
other's carts. With the `buyer` fixture each worker holds one account exclusively for its
lifetime, waits its turn when all three are taken, and returns the account when it exits.

```bash
pnpm install && pnpm build        # from the repository root
cd examples/playwright
pnpm demo                          # starts a server, runs the suite, verifies the event log
```

What the demo verifies after the run:

- the tests' own usage log shows no overlapping use of any account,
- the server's event log alternates strictly between acquire and release per account,
- exactly 8 worker leases were acquired and at least 5 of them had to wait,
- every account is available again and nobody is still waiting.

Every test gets a sanitized `testlease.json` attachment (visible in the HTML report) that says
which account it ran on, who owned the lease, whether the heartbeat stayed healthy and whether
the lease expired during the test. It never contains secrets.

Files:

- `testlease.yml` – the pool: three accounts with tags, metadata and `env:` secret references
- `tests/fixtures.ts` – `withTestLease(base, { fixtures: { buyer: { pool, scope: 'worker' } } })`
- `tests/*.spec.ts` – 24 tests that "log in" with `buyer.metadata.email` and `buyer.secrets.password`
- `scripts/run-demo.mjs` – starts the server, runs Playwright, checks the evidence

The worker-crash and TTL-recovery scenario lives in the adapter's own test suite:
`packages/playwright/test/adapter.test.ts` (project `crash`).
