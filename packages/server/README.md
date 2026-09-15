# @testlease/server

The HTTP server of [TestLease](https://github.com/testlease/testlease): versioned REST API on
Hono, Bearer token authentication with scopes, request logging, client-disconnect handling for
long-polling acquisitions and a graceful shutdown that keeps active leases.

Most deployments use the `testlease` CLI (`testlease serve`) or the Docker image. Embed the server
when you need a custom host:

```ts
import { createTestLease, loadRuntimeConfig } from '@testlease/core';
import { startServer, createLogger } from '@testlease/server';

const { config } = loadRuntimeConfig({ path: './testlease.yml' });
const logger = createLogger({ level: config.server.logLevel });
const engine = await createTestLease({ config, logger });
const server = await startServer({ engine, logger });
process.on('SIGTERM', () => void server.close());
```

Binding a non-loopback address without tokens is refused unless `server.allowInsecureRemote` is
set. See the [API reference](https://github.com/testlease/testlease/blob/main/docs/api.md) and
[configuration](https://github.com/testlease/testlease/blob/main/docs/configuration.md).
