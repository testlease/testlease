import type { SqliteDatabase } from './database.js';
import type { Logger } from '../logger.js';
import { noopLogger } from '../logger.js';

export interface Migration {
  version: number;
  name: string;
  up: string;
}

/**
 * Schema migrations are append-only. Never edit an applied migration; add a new one.
 * The unique partial index `leases_one_active_per_resource` is the database-level guarantee
 * behind invariant #1 (never double-lease).
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
CREATE TABLE pools (
  name            TEXT PRIMARY KEY,
  description     TEXT,
  default_ttl_ms  INTEGER NOT NULL CHECK (default_ttl_ms > 0),
  max_ttl_ms      INTEGER NOT NULL CHECK (max_ttl_ms >= default_ttl_ms),
  present         INTEGER NOT NULL DEFAULT 1 CHECK (present IN (0, 1)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE TABLE resources (
  id                 TEXT PRIMARY KEY,
  pool               TEXT NOT NULL REFERENCES pools(name),
  state              TEXT NOT NULL CHECK (state IN ('AVAILABLE', 'LEASED', 'QUARANTINED', 'DISABLED')),
  enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  metadata_json      TEXT NOT NULL DEFAULT '{}',
  secret_refs_json   TEXT NOT NULL DEFAULT '{}',
  active_lease_id    TEXT,
  quarantine_reason  TEXT,
  quarantined_at     INTEGER,
  quarantined_by     TEXT,
  last_leased_at     INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK ((state = 'LEASED') = (active_lease_id IS NOT NULL)),
  CHECK ((state = 'QUARANTINED') = (quarantine_reason IS NOT NULL))
) STRICT;
CREATE INDEX resources_pool_state ON resources(pool, state);

CREATE TABLE leases (
  id                 TEXT PRIMARY KEY,
  resource_id        TEXT NOT NULL REFERENCES resources(id),
  pool               TEXT NOT NULL,
  owner              TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('ACTIVE', 'RELEASED', 'EXPIRED')),
  client_request_id  TEXT,
  purpose            TEXT,
  metadata_json      TEXT,
  ttl_ms             INTEGER NOT NULL CHECK (ttl_ms > 0),
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  last_heartbeat_at  INTEGER NOT NULL,
  ended_at           INTEGER,
  end_reason         TEXT CHECK (end_reason IN ('RELEASED', 'QUARANTINED', 'EXPIRED', 'FORCE_RELEASED')),
  CHECK ((state = 'ACTIVE') = (ended_at IS NULL)),
  CHECK ((state = 'ACTIVE') = (end_reason IS NULL))
) STRICT;
-- Invariant #1: at most one ACTIVE lease per resource, enforced by the database.
CREATE UNIQUE INDEX leases_one_active_per_resource ON leases(resource_id) WHERE state = 'ACTIVE';
-- Idempotency: one ACTIVE lease per client request id.
CREATE UNIQUE INDEX leases_one_active_per_request ON leases(client_request_id)
  WHERE state = 'ACTIVE' AND client_request_id IS NOT NULL;
CREATE INDEX leases_active_expiry ON leases(expires_at) WHERE state = 'ACTIVE';
CREATE INDEX leases_resource_created ON leases(resource_id, created_at);
CREATE INDEX leases_owner ON leases(owner);

CREATE TABLE lease_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  type         TEXT NOT NULL,
  pool         TEXT,
  resource_id  TEXT,
  lease_id     TEXT,
  owner        TEXT,
  details_json TEXT
) STRICT;
CREATE INDEX lease_events_lease ON lease_events(lease_id, seq);
CREATE INDEX lease_events_resource ON lease_events(resource_id, seq);
`,
  },
];

export interface MigrationResult {
  applied: number[];
  version: number;
}

export function currentSchemaVersion(db: SqliteDatabase): number {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`)
    .get();
  if (!exists) return 0;
  const row = db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations`).get() as {
    v: number;
  };
  return row.v;
}

export function migrate(db: SqliteDatabase, logger: Logger = noopLogger): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  ) STRICT`);

  const appliedRows = db
    .prepare(`SELECT version FROM schema_migrations ORDER BY version`)
    .all() as {
    version: number;
  }[];
  const appliedSet = new Set(appliedRows.map((r) => r.version));
  const applied: number[] = [];

  const insert = db.prepare(
    `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`,
  );
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (appliedSet.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.up);
      insert.run(migration.version, migration.name, Date.now());
    }).immediate();
    applied.push(migration.version);
    logger.info(
      { event: 'schema.migrated', version: migration.version, name: migration.name },
      'applied migration',
    );
  }

  const version = currentSchemaVersion(db);
  const latest = Math.max(...migrations.map((m) => m.version));
  if (version > latest) {
    throw new Error(
      `Database schema version ${version} is newer than this TestLease build supports (${latest}). Upgrade TestLease.`,
    );
  }
  return { applied, version };
}
