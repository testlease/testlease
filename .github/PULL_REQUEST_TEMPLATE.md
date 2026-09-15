## What

<!-- One paragraph: what changes and why. Link the issue. -->

## How it was verified

<!-- Which suites ran (unit / concurrency / integration / mcp / playwright)? Paste the relevant
     assertion or numbers for concurrency-related changes. -->

## Checklist

- [ ] Changeset added (`pnpm changeset`) or not needed (docs/tests only)
- [ ] No secret value can reach logs, events, evidence or MCP responses through this change
- [ ] Wire format unchanged, or `docs/api.md` + protocol package updated
- [ ] ADR added/updated if a decision changed
- [ ] Migrations are append-only
