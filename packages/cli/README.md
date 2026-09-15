# testlease

Stop parallel tests from fighting over shared test accounts and environments. This package is the
[TestLease](https://github.com/testlease/testlease) server and command line.

```bash
npx testlease serve --config testlease.yml      # REST API + MCP at http://127.0.0.1:4747
npx testlease status                            # capacity per pool
npx testlease inspect premium-buyers            # who holds what, until when
npx testlease acquire premium-buyers --tag region=nl --wait 60s
npx testlease release <lease-id>
npx testlease quarantine <lease-id> --reason "account locked"
npx testlease restore buyer-03
npx testlease events <lease-id>                 # evidence trail
npx testlease exec --pool premium-buyers -- npm test   # lease + secrets in env + release
npx testlease doctor                            # config, secrets, connectivity, scopes
npx testlease mcp --url http://127.0.0.1:4747   # MCP over stdio for agent hosts
```

Global options: `--url` (`$TESTLEASE_URL`), `--token` (`$TESTLEASE_TOKEN`), `--owner`
(`$TESTLEASE_OWNER`), `--json`, `--no-color`. Exit codes: 0 ok, 1 error, 2 usage/config,
3 no resource (timeout/exhausted/no match), 4 server unreachable.

Configuration:

```yaml
pools:
  premium-buyers:
    defaultTtl: 10m
    resources:
      - id: buyer-01
        tags: { region: nl }
        metadata: { email: buyer01@example.test }
        secrets: { password: env:BUYER_01_PASSWORD }
```

Full documentation, Playwright fixtures, MCP details and the security model:
https://github.com/testlease/testlease
