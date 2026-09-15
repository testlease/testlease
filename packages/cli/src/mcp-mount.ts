import type { Logger, TestLeaseConfig, TestLeaseEngine } from '@testlease/core';
import { createMcpHttpHandler } from '@testlease/mcp';
import {
  createAuthenticatorFromConfig,
  isLoopbackHost,
  type Authenticator,
  type TestLeaseApp,
} from '@testlease/server';

/**
 * Mounts MCP Streamable HTTP at /mcp on the REST server. Authentication reuses the REST token
 * authenticator; each MCP session acts as the token's principal.
 */
export async function mountMcp(
  app: TestLeaseApp,
  engine: TestLeaseEngine,
  config: TestLeaseConfig,
  logger: Logger,
  authenticator?: Authenticator,
): Promise<void> {
  authenticator ??= await createAuthenticatorFromConfig(engine);
  const handler = createMcpHttpHandler({
    loopback: isLoopbackHost(config.server.host),
    allowQuarantine: config.mcp.allowQuarantine,
    version: engine.config ? '0.1.0' : '0.1.0',
    authenticate: (request) => {
      const auth = authenticator.authenticate(request.headers.get('authorization') ?? undefined);
      if (!auth) return null;
      return {
        principal: auth.principal,
        api: engine.api.as(auth.principal, { pools: auth.pools }),
      };
    },
    log: (level, obj, msg) => logger[level](obj, msg),
  });
  app.all('/mcp', (c) => handler.fetch(c.req.raw));
  logger.info(
    { event: 'mcp.mounted', path: '/mcp', quarantineTool: config.mcp.allowQuarantine },
    'MCP Streamable HTTP endpoint mounted',
  );
}
