import type { Command } from 'commander';
import { ConfigError, createTestLease, loadRuntimeConfig, type Logger } from '@testlease/core';
import { createLogger, startServer } from '@testlease/server';
import type { CliContext } from '../context.js';
import { EXIT } from '../output.js';

export interface ServeOptions {
  config?: string;
  host?: string;
  port?: string;
  db?: string;
  logLevel?: string;
  allowInsecureRemote?: boolean;
  mcp: boolean;
  pretty?: boolean;
}

export async function runServe(
  ctx: CliContext,
  opts: ServeOptions,
  hooks: { onReady?: (url: string) => void; signals?: boolean } = {},
): Promise<number> {
  let loaded;
  try {
    loaded = loadRuntimeConfig({
      path: opts.config,
      env: ctx.env,
      optional: !opts.config && !ctx.env.TESTLEASE_CONFIG,
    });
  } catch (err) {
    ctx.out.err(
      `${ctx.out.paint(['red', 'bold'], 'Configuration error')}: ${(err as Error).message}`,
    );
    return EXIT.USAGE;
  }
  const { config, warnings, source } = loaded;
  if (opts.host) config.server.host = opts.host;
  if (opts.port !== undefined) config.server.port = Number(opts.port);
  if (opts.db) config.server.db = opts.db;
  if (opts.logLevel) config.server.logLevel = opts.logLevel as typeof config.server.logLevel;
  if (opts.allowInsecureRemote) config.server.allowInsecureRemote = true;

  const pretty = opts.pretty ?? Boolean((process.stdout as NodeJS.WriteStream).isTTY);
  const logger: Logger = createLogger({ level: config.server.logLevel, pretty });
  for (const w of warnings) logger.warn({ event: 'config.warning' }, w);
  logger.info(
    { event: 'config.loaded', source, pools: Object.keys(config.pools).length },
    'configuration loaded',
  );

  // Re-read the same file (and env) on reload; CLI flag overrides are re-applied because they
  // describe this process, not the file.
  const applyFlags = (c: typeof config) => {
    if (opts.host) c.server.host = opts.host;
    if (opts.port !== undefined) c.server.port = Number(opts.port);
    if (opts.db) c.server.db = opts.db;
    if (opts.logLevel) c.server.logLevel = opts.logLevel as typeof c.server.logLevel;
    if (opts.allowInsecureRemote) c.server.allowInsecureRemote = true;
    return c;
  };
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let engine;
  try {
    engine = await createTestLease({
      config,
      logger,
      version: CLI_VERSION,
      authMode: config.auth.tokens.length ? 'token' : 'insecure-local',
      mcpHttp: opts.mcp && config.mcp.http,
      configLoader: () => {
        const again = loadRuntimeConfig({
          path: opts.config,
          env: ctx.env,
          optional: !opts.config && !ctx.env.TESTLEASE_CONFIG,
        });
        return { ...again, config: applyFlags(again.config) };
      },
      onReload: async (_next, result) => {
        await server?.reloadAuth();
        logger.info(
          { event: 'config.reloaded', reloads: result.reloads, warnings: result.warnings },
          'configuration reloaded',
        );
      },
    });
  } catch (err) {
    ctx.out.err(
      `${ctx.out.paint(['red', 'bold'], err instanceof ConfigError ? 'Configuration error' : 'Startup failed')}: ${(err as Error).message}`,
    );
    return EXIT.USAGE;
  }

  try {
    const { mountMcp } = await import('../mcp-mount.js');
    server = await startServer({
      engine,
      logger,
      extend:
        opts.mcp && config.mcp.http
          ? (app, { authenticator }) => mountMcp(app, engine, config, logger, authenticator)
          : undefined,
    });
  } catch (err) {
    engine.close();
    ctx.out.err(`${ctx.out.paint(['red', 'bold'], 'Startup failed')}: ${(err as Error).message}`);
    return EXIT.USAGE;
  }
  const running = server;
  hooks.onReady?.(running.url);

  if (hooks.signals !== false) {
    const shutdown = (signal: string) => {
      logger.info({ event: 'server.signal', signal }, 'shutdown requested');
      void running.close({ timeoutMs: 10_000 }).then(() => process.exit(0));
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    const reloadEngine = engine;
    process.on('SIGHUP', () => {
      logger.info({ event: 'server.signal', signal: 'SIGHUP' }, 'configuration reload requested');
      reloadEngine
        .reload()
        .catch((err: Error) =>
          logger.error(
            { event: 'config.reload_failed', error: err.message },
            'reload rejected; running configuration unchanged',
          ),
        );
    });
  }
  // Keep running until closed.
  await new Promise<void>((resolve) => {
    const orig = running.close.bind(running);
    running.close = async (o) => {
      await orig(o);
      resolve();
    };
  });
  return EXIT.OK;
}

export const CLI_VERSION = '0.1.0';

export function registerServeCommand(program: Command, getCtx: () => CliContext): void {
  program
    .command('serve')
    .description('Start the TestLease server (REST API + MCP Streamable HTTP)')
    .option(
      '-c, --config <path>',
      'configuration file (default: $TESTLEASE_CONFIG or ./testlease.yml)',
    )
    .option('-H, --host <host>', 'bind address (default: 127.0.0.1)')
    .option('-P, --port <port>', 'port (default: 4747)')
    .option('--db <path>', 'SQLite database path (default: ./testlease.db)')
    .option('--log-level <level>', 'fatal|error|warn|info|debug|trace|silent')
    .option(
      '--allow-insecure-remote',
      'allow binding a non-loopback address without tokens (NOT recommended)',
    )
    .option('--no-mcp', 'do not serve MCP over HTTP at /mcp')
    .option('--pretty', 'pretty-print logs (default when attached to a terminal)')
    .option('--no-pretty', 'always emit JSON logs')
    .action(async (opts: ServeOptions) => {
      process.exitCode = await runServe(getCtx(), opts);
    });

  program
    .command('validate')
    .description('Validate the configuration file and secret references without starting a server')
    .option('-c, --config <path>', 'configuration file')
    .action(async (opts: { config?: string }) => {
      const ctx = getCtx();
      const { runValidate } = await import('../doctor.js');
      process.exitCode = await runValidate(ctx, opts.config);
    });
}
