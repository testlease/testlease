---
'@testlease/core': minor
---

Add schema migration 3: an index on `lease_events(pool, at)` so pool-scoped event history reads
only that pool's events. The migration runs automatically on startup. After upgrading, earlier
versions refuse this database (schema version 3 is newer than they support), so roll back only
together with a database backup taken before the upgrade.
