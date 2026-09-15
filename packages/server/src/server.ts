import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { ConfigError, type Logger, type TestLeaseEngine } from '@testlease/core';
import { createAuthenticator, isLoopbackHost, resolveTokens, type Authenticator } from './auth.js';
import { createApp, type TestLeaseApp } from './app.js';

export interface StartServerOptions {
  engine: TestLeaseEngine;
  logger: Logger;
  /** Overrides `engine.config.server.host` / `.port`. Port 0 picks a free port. */
  host?: string;
  port?: number;
  /** Mount additional routes (e.g. the MCP endpoint) before the server starts listening. */
  extend?: (app: TestLeaseApp) => void | Promise<void>;
}

export interface RunningServer {
  url: string;
  host: string;
  port: number;
  authMode: Authenticator['mode'];
  app: TestLeaseApp;
  /**
   * Graceful shutdown: stop accepting connections, fail waiting acquisitions with
   * SERVER_SHUTTING_DOWN, close the database. Active leases are intentionally kept.
   */
  close(options?: { timeoutMs?: number }): Promise<void>;
}

/**
 * Refuses obviously insecure deployments: a non-loopback bind without any API token requires
 * an explicit `allowInsecureRemote` opt-in.
 */
export function assertSafeBinding(
  host: string,
  tokenCount: number,
  allowInsecureRemote: boolean,
): void {
  if (isLoopbackHost(host) || tokenCount > 0) return;
  if (allowInsecureRemote) return;
  throw new ConfigError(
    `Refusing to bind ${host} without authentication.\n` +
      `Either configure API tokens (auth.tokens or TESTLEASE_TOKEN), bind to 127.0.0.1, ` +
      `or set server.allowInsecureRemote: true (TESTLEASE_ALLOW_INSECURE_REMOTE=1) if the network is trusted.`,
  );
}

export async function createAuthenticatorFromConfig(
  engine: TestLeaseEngine,
): Promise<Authenticator> {
  const tokens = await resolveTokens(engine.config, engine.secrets);
  return createAuthenticator(tokens);
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const { engine, logger } = options;
  const host = options.host ?? engine.config.server.host;
  const port = options.port ?? engine.config.server.port;
  const authenticator = await createAuthenticatorFromConfig(engine);
  assertSafeBinding(
    host,
    engine.config.auth.tokens.length,
    engine.config.server.allowInsecureRemote,
  );
  if (!isLoopbackHost(host) && authenticator.mode === 'insecure-local') {
    logger.warn(
      { event: 'server.insecure_remote', host },
      'SERVER IS REACHABLE FROM THE NETWORK WITHOUT AUTHENTICATION (allowInsecureRemote is set)',
    );
  }

  const app = createApp({
    engine,
    authenticator,
    logger,
    bodyLimitBytes: engine.config.server.requestBodyLimitBytes,
  });
  await options.extend?.(app);

  const server = await new Promise<ServerType>((resolve, reject) => {
    function onError(err: Error): void {
      reject(err);
    }
    const s = serve({ fetch: app.fetch, hostname: host, port }, () => {
      s.off('error', onError);
      resolve(s);
    });
    s.once('error', onError);
  });
  // Long-poll acquisitions can legitimately be idle for minutes.
  if ('requestTimeout' in server) server.requestTimeout = 0;
  if ('headersTimeout' in server) server.headersTimeout = 60_000;

  const address = server.address() as AddressInfo;
  const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const url = `http://${displayHost}:${address.port}`;
  logger.info(
    {
      event: 'server.started',
      url,
      authMode: authenticator.mode,
      pools: engine.service.listPools().length,
    },
    'TestLease listening',
  );

  let closing: Promise<void> | null = null;
  return {
    url,
    host: address.address,
    port: address.port,
    authMode: authenticator.mode,
    app,
    close: (opts = {}) => {
      closing ??= (async () => {
        const timeoutMs = opts.timeoutMs ?? 5_000;
        logger.info({ event: 'server.stopping' }, 'shutting down; active leases are kept');
        engine.service.stop(); // waiting acquisitions get SERVER_SHUTTING_DOWN responses
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        if ('closeIdleConnections' in server) server.closeIdleConnections();
        const timer = setTimeout(() => {
          if ('closeAllConnections' in server) server.closeAllConnections();
        }, timeoutMs);
        await closed;
        clearTimeout(timer);
        engine.close();
        logger.info({ event: 'server.stopped' }, 'stopped');
      })();
      return closing;
    },
  };
}
