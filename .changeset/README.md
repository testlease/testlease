# Changesets

Every user-facing change ships with a changeset (`pnpm changeset`). All publishable packages
are versioned together (`fixed` group) so `testlease@0.1.x` always pairs with
`@testlease/client@0.1.x`. `CHANGELOG.md` files are generated from changesets at release time;
the release workflow opens a "Version Packages" PR and publishes only when it is merged and an
npm token is configured. Nothing is published from a developer machine.
