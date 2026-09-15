import type { AuthMode, ConfigReloadResponse } from '@testlease/protocol';
import { ErrorCodes, TestLeaseError } from '@testlease/protocol';
import { type Clock, MonotonicClock } from './clock.js';
import {
  applyEnvOverrides,
  checkSecretRefs,
  ConfigError,
  formatSecretProblems,
  loadConfigFile,
  validateConfig,
} from './config/load.js';
import type { TestLeaseConfig } from './config/schema.js';
import { openDatabase, type SqliteDatabase } from './db/database.js';
import { migrate } from './db/migrations.js';
import { syncConfig, type SyncSummary } from './domain/config-sync.js';
import { LeaseService, LOCAL_PRINCIPAL } from './domain/lease-service.js';
import { LocalTestLeaseApi, type LocalApiRuntime } from './domain/local-api.js';
import { type Logger, noopLogger } from './logger.js';
import { type SecretResolver, SecretResolverRegistry } from './secrets/resolver.js';
import { SqliteStore } from './store/sqlite-store.js';

export interface CreateTestLeaseOptions {
  config: TestLeaseConfig;
  /** Overrides `config.server.db`. Use `:memory:` for tests. */
  dbPath?: string;
  /** Defaults to a MonotonicClock anchored at startup (immune to wall-clock jumps). */
  clock?: Clock;
  logger?: Logger;
  secretResolvers?: SecretResolver[];
  /** What to do when a configured secret reference cannot be resolved at startup. */
  onMissingSecrets?: 'fail' | 'warn';
  version?: string;
  /** Reported in /healthz; the engine itself does not enforce auth. */
  authMode?: AuthMode;
  mcpHttp?: boolean;
  /**
   * Re-reads configuration for `engine.reload()`. Return the new (already env-overridden) config
   * and warnings. When omitted, `reload()` only accepts an explicit config object.
   */
  configLoader?: () => LoadedRuntimeConfig;
  /** Called after every successful reload (the server rebuilds its authenticator from it). */
  onReload?: (config: TestLeaseConfig, result: ConfigReloadResponse) => void | Promise<void>;
  /** History pruning interval (default 1h). 0 disables the timer; `pruneHistory()` still works. */
  pruneIntervalMs?: number;
}

export interface TestLeaseEngine {
  /** Current configuration (replaced by `reload()`). */
  config: TestLeaseConfig;
  db: SqliteDatabase;
  store: SqliteStore;
  service: LeaseService;
  secrets: SecretResolverRegistry;
  /** API bound to the `local` principal. Use `api.as(principal, { pools })` for authenticated callers. */
  api: LocalTestLeaseApi;
  schemaVersion: number;
  sync: SyncSummary;
  clock: Clock;
  /**
   * Applies new configuration without a restart: pools/resources are synchronised, waiters are
   * re-evaluated, `history` settings take effect. `server.*` changes are reported as warnings
   * because host/port/db cannot change at runtime.
   */
  reload(options?: { config?: TestLeaseConfig }): Promise<ConfigReloadResponse>;
  /** Deletes events and ended leases older than `history.retention`. */
  pruneHistory(): { events: number; leases: number };
  /** Stops timers and closes the database. Active leases are kept (see ADR-0002). */
  close(): void;
}

/**
 * Boots the leasing engine: open SQLite, migrate, verify secret references, sync configuration,
 * expire anything overdue from before the restart, arm the expiry timer and the history pruner.
 */
export async function createTestLease(options: CreateTestLeaseOptions): Promise<TestLeaseEngine> {
  const clock = options.clock ?? new MonotonicClock();
  const logger = options.logger ?? noopLogger;
  const secrets = new SecretResolverRegistry(options.secretResolvers);
  const failOnMissing = (options.onMissingSecrets ?? 'fail') === 'fail';

  await assertSecrets(options.config, secrets, logger, failOnMissing);

  const dbPath = options.dbPath ?? options.config.server.db;
  const db = openDatabase(dbPath);
  try {
    const migration = migrate(db, logger);
    const store = new SqliteStore(db);
    const sync = syncConfig(store, options.config, clock.now(), logger);
    logSync(logger, sync);

    const service = new LeaseService({
      store,
      clock,
      logger,
      maxWaitMs: options.config.server.maxWait,
      recordRenewals: options.config.history.recordRenewals,
    });
    const runtime: LocalApiRuntime = {
      shuttingDown: false,
      configLoadedAt: clock.now(),
      reloads: 0,
      wallDriftMs: clock instanceof MonotonicClock ? () => clock.wallDriftMs() : () => 0,
    };
    const api = new LocalTestLeaseApi(
      service,
      secrets,
      clock,
      {
        version: options.version ?? '0.0.0-dev',
        startedAt: clock.now(),
        schemaVersion: migration.version,
        authMode: options.authMode ?? 'insecure-local',
        mcpHttp: options.mcpHttp ?? false,
      },
      runtime,
      LOCAL_PRINCIPAL,
    );
    service.start();

    const engine: TestLeaseEngine = {
      config: options.config,
      db,
      store,
      service,
      secrets,
      api,
      schemaVersion: migration.version,
      sync,
      clock,
      pruneHistory: () => service.pruneHistory(engine.config.history.retention),
      reload: async (reloadOptions = {}) => {
        let next: TestLeaseConfig;
        let warnings: string[] = [];
        if (reloadOptions.config) {
          next = reloadOptions.config;
        } else if (options.configLoader) {
          try {
            const loaded = options.configLoader();
            next = loaded.config;
            warnings = [...loaded.warnings];
          } catch (err) {
            throw new TestLeaseError(
              ErrorCodes.CONFIG_INVALID,
              `Configuration reload rejected; the running configuration is unchanged. ${(err as Error).message}`,
            );
          }
        } else {
          throw new TestLeaseError(
            ErrorCodes.CONFIG_INVALID,
            'No configuration source to reload from.',
          );
        }
        const problems = await checkSecretRefs(next, secrets);
        if (problems.length) {
          if (failOnMissing) {
            throw new TestLeaseError(
              ErrorCodes.CONFIG_INVALID,
              `Configuration reload rejected; the running configuration is unchanged.\n${formatSecretProblems(problems)}`,
              { missingSecrets: problems.map((p) => p.ref) },
            );
          }
          warnings.push(formatSecretProblems(problems));
        }
        const prev = engine.config;
        for (const key of ['host', 'port', 'db', 'requestBodyLimitBytes'] as const) {
          if (prev.server[key] !== next.server[key])
            warnings.push(`server.${key} changed; requires a restart`);
        }
        const summary = syncConfig(store, next, clock.now(), logger);
        engine.config = next;
        service.recordRenewals = next.history.recordRenewals;
        service.notifyAllPools();
        runtime.configLoadedAt = clock.now();
        runtime.reloads++;
        const result: ConfigReloadResponse = {
          ...summary,
          warnings,
          loadedAt: runtime.configLoadedAt,
          reloads: runtime.reloads,
        };
        logSync(logger, summary, 'configuration reloaded');
        await options.onReload?.(next, result);
        return result;
      },
      close: () => {
        runtime.shuttingDown = true;
        if (pruneTimer) clearInterval(pruneTimer);
        service.stop();
        db.close();
      },
    };
    runtime.reload = () => engine.reload();

    engine.pruneHistory();
    const interval = options.pruneIntervalMs ?? 3_600_000;
    const pruneTimer = interval > 0 ? setInterval(() => engine.pruneHistory(), interval) : null;
    pruneTimer?.unref();
    return engine;
  } catch (err) {
    db.close();
    throw err;
  }
}

async function assertSecrets(
  config: TestLeaseConfig,
  secrets: SecretResolverRegistry,
  logger: Logger,
  fail: boolean,
): Promise<void> {
  const problems = await checkSecretRefs(config, secrets);
  if (!problems.length) return;
  const text = formatSecretProblems(problems);
  if (fail) throw new ConfigError(text);
  logger.warn({ event: 'config.secrets_missing', count: problems.length }, text);
}

function logSync(logger: Logger, sync: SyncSummary, msg = 'configuration synchronised'): void {
  logger.info(
    {
      event: 'config.synced',
      pools: sync.pools,
      resources: sync.resources,
      registered: sync.registered.length,
      updated: sync.updated.length,
      disabled: sync.disabled.length,
      enabled: sync.enabled.length,
      absentPools: sync.absentPools,
    },
    msg,
  );
}

export interface LoadConfigOptions {
  /** Path to testlease.yml. When omitted, TESTLEASE_CONFIG or ./testlease.yml is tried. */
  path?: string;
  env?: NodeJS.ProcessEnv;
  /** Inline configuration object (tests / embedding). Takes precedence over `path`. */
  inline?: unknown;
  /** When true and no file exists, start with an empty configuration instead of failing. */
  optional?: boolean;
}

export interface LoadedRuntimeConfig {
  config: TestLeaseConfig;
  warnings: string[];
  source: string;
}

export function loadRuntimeConfig(options: LoadConfigOptions = {}): LoadedRuntimeConfig {
  const env = options.env ?? process.env;
  let loaded;
  if (options.inline !== undefined) {
    loaded = validateConfig(options.inline, '<inline>');
  } else {
    const path = options.path ?? env.TESTLEASE_CONFIG ?? './testlease.yml';
    try {
      loaded = loadConfigFile(path);
    } catch (err) {
      if (
        options.optional &&
        err instanceof ConfigError &&
        err.message.includes('file not found')
      ) {
        loaded = validateConfig({}, '<defaults>');
        loaded.warnings.push(`No configuration file found at ${path}; starting with no pools.`);
      } else {
        throw err;
      }
    }
  }
  return {
    config: applyEnvOverrides(loaded.config, env),
    warnings: loaded.warnings,
    source: loaded.source,
  };
}
