import type { AuthMode } from '@testlease/protocol';
import { type Clock, systemClock } from './clock.js';
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
import { LeaseService } from './domain/lease-service.js';
import { LocalTestLeaseApi } from './domain/local-api.js';
import { type Logger, noopLogger } from './logger.js';
import { type SecretResolver, SecretResolverRegistry } from './secrets/resolver.js';
import { SqliteStore } from './store/sqlite-store.js';

export interface CreateTestLeaseOptions {
  config: TestLeaseConfig;
  /** Overrides `config.server.db`. Use `:memory:` for tests. */
  dbPath?: string;
  clock?: Clock;
  logger?: Logger;
  secretResolvers?: SecretResolver[];
  /** What to do when a configured secret reference cannot be resolved at startup. */
  onMissingSecrets?: 'fail' | 'warn';
  version?: string;
  /** Reported in /healthz; the engine itself does not enforce auth. */
  authMode?: AuthMode;
  mcpHttp?: boolean;
}

export interface TestLeaseEngine {
  config: TestLeaseConfig;
  db: SqliteDatabase;
  store: SqliteStore;
  service: LeaseService;
  secrets: SecretResolverRegistry;
  api: LocalTestLeaseApi;
  schemaVersion: number;
  sync: SyncSummary;
  /** Stops timers and closes the database. Active leases are kept (see ADR-0002). */
  close(): void;
}

/**
 * Boots the leasing engine: open SQLite, migrate, verify secret references, sync configuration,
 * expire anything overdue from before the restart, and arm the expiry timer.
 */
export async function createTestLease(options: CreateTestLeaseOptions): Promise<TestLeaseEngine> {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? noopLogger;
  const secrets = new SecretResolverRegistry(options.secretResolvers);

  const problems = await checkSecretRefs(options.config, secrets);
  if (problems.length) {
    const text = formatSecretProblems(problems);
    if ((options.onMissingSecrets ?? 'fail') === 'fail') {
      throw new ConfigError(text);
    }
    logger.warn({ event: 'config.secrets_missing', count: problems.length }, text);
  }

  const dbPath = options.dbPath ?? options.config.server.db;
  const db = openDatabase(dbPath);
  let engine: TestLeaseEngine;
  try {
    const migration = migrate(db, logger);
    const store = new SqliteStore(db);
    const sync = syncConfig(store, options.config, clock.now(), logger);
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
      'configuration synchronised',
    );
    const service = new LeaseService({
      store,
      clock,
      logger,
      maxWaitMs: options.config.server.maxWait,
    });
    const api = new LocalTestLeaseApi(service, secrets, clock, {
      version: options.version ?? '0.0.0-dev',
      startedAt: clock.now(),
      schemaVersion: migration.version,
      authMode: options.authMode ?? 'insecure-local',
      mcpHttp: options.mcpHttp ?? false,
    });
    service.start();
    engine = {
      config: options.config,
      db,
      store,
      service,
      secrets,
      api,
      schemaVersion: migration.version,
      sync,
      close: () => {
        api.shuttingDown = true;
        service.stop();
        db.close();
      },
    };
  } catch (err) {
    db.close();
    throw err;
  }
  return engine;
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
