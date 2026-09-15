# @testlease/protocol

Wire types, stable error codes and the framework-neutral API contract of
[TestLease](https://github.com/testlease/testlease). No runtime dependencies.

```ts
import {
  ErrorCodes,
  isTestLeaseError,
  type AcquireRequest,
  type LeaseView,
  type TestLeaseApi,
} from '@testlease/protocol';
```

- `TestLeaseApi` — what every adapter is written against (implemented over HTTP by
  `@testlease/client` and in-process by `@testlease/core`).
- `SecretsApi` — deliberately separate, so components that must never see credentials (the MCP
  server) cannot reach it.
- `TestLeaseError` with `code` from `ErrorCodes`; switch on codes, not messages.

See the [HTTP API reference](https://github.com/testlease/testlease/blob/main/docs/api.md).
