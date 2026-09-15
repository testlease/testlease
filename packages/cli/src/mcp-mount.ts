import type { Logger, TestLeaseConfig, TestLeaseEngine } from '@testlease/core';
import type { TestLeaseApp } from '@testlease/server';

/**
 * Mounts the MCP Streamable HTTP endpoint at /mcp. Implemented by the MCP phase;
 * until then serving MCP over HTTP is a no-op and /healthz reports mcp.http accordingly.
 */
export function mountMcp(
  _app: TestLeaseApp,
  _engine: TestLeaseEngine,
  _config: TestLeaseConfig,
  logger: Logger,
): void {
  logger.warn({ event: 'mcp.unavailable' }, 'MCP over HTTP is not available in this build');
}
