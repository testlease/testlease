---
'@testlease/protocol': minor
'@testlease/core': minor
'@testlease/server': minor
'@testlease/client': minor
---

Add pool-scoped event history: `TestLeaseApi.listPoolEvents(pool, { sinceMs, limit })`, served by
`GET /v1/pools/:pool/events?since=&limit=` (scope `pool:read`, pool allow-lists apply) and
`TestLeaseClient.listPoolEvents`. Events are returned newest first; `since` is inclusive, `limit`
defaults to 1000 and values above 5000 are capped. Unlike resource history, this includes
`ACQUIRE_TIMEOUT` events, which have no resource. Custom implementations of `TestLeaseApi` must
add the new method.
