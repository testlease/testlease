import { describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../../src/db/database.js';
import { currentSchemaVersion, migrate, migrations } from '../../src/db/migrations.js';

// The query `listPoolEvents` will run (PR 1). Kept here so the plan assertion tracks it.
const POOL_EVENTS_SQL = `SELECT * FROM lease_events WHERE pool = ? AND at >= ? ORDER BY at DESC, seq DESC LIMIT ?`;

const indexColumns = (db: SqliteDatabase, index: string): string[] =>
  (db.prepare(`PRAGMA index_info(${index})`).all() as { name: string }[]).map((c) => c.name);

const queryPlan = (db: SqliteDatabase): string =>
  (db.prepare(`EXPLAIN QUERY PLAN ${POOL_EVENTS_SQL}`).all('p', 0, 10) as { detail: string }[])
    .map((r) => r.detail)
    .join(' | ');

/** A database exactly as v0.2 left it: migrations 1 and 2 only. */
function v02Database(): SqliteDatabase {
  const db = openDatabase(':memory:');
  db.exec(
    `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT`,
  );
  const insert = db.prepare(
    `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`,
  );
  for (const m of migrations.filter((m) => m.version <= 2)) {
    db.exec(m.up);
    insert.run(m.version, m.name, Date.now());
  }
  return db;
}

describe('migration 3 (pool events index)', () => {
  it('is appended as version 3 and versions stay contiguous', () => {
    expect(migrations.map((m) => m.version)).toEqual([1, 2, 3]);
    expect(migrations[2]!.name).toBe('lease-events-pool-at-index');
  });

  it('creates lease_events_pool_at on (pool, at) in a fresh database', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    expect(currentSchemaVersion(db)).toBe(3);
    expect(indexColumns(db, 'lease_events_pool_at')).toEqual(['pool', 'at']);
    db.close();
  });

  it('upgrades a v0.2 database in place and keeps its events', () => {
    const db = v02Database();
    const now = Date.now();
    const insertEvent = db.prepare(
      `INSERT INTO lease_events (at, type, pool, resource_id, lease_id, owner, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertEvent.run(now - 2000, 'LEASE_ACQUIRED', 'p', 'r', 'l1', 'o', '{"waitedMs":0}');
    insertEvent.run(now - 1000, 'ACQUIRE_TIMEOUT', 'p', null, null, 'o', '{"waitedMs":500}');
    expect(currentSchemaVersion(db)).toBe(2);

    const result = migrate(db);
    expect(result.applied).toEqual([3]);
    expect(currentSchemaVersion(db)).toBe(3);
    expect(indexColumns(db, 'lease_events_pool_at')).toEqual(['pool', 'at']);
    const rows = db.prepare(`SELECT type FROM lease_events ORDER BY seq`).all() as {
      type: string;
    }[];
    expect(rows.map((r) => r.type)).toEqual(['LEASE_ACQUIRED', 'ACQUIRE_TIMEOUT']);
    expect(migrate(db).applied).toEqual([]);
    db.close();
  });

  it('keeps the existing lease_events indexes', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    expect(indexColumns(db, 'lease_events_at')).toEqual(['at']);
    expect(indexColumns(db, 'lease_events_lease')).toEqual(['lease_id', 'seq']);
    expect(indexColumns(db, 'lease_events_resource')).toEqual(['resource_id', 'seq']);
    db.close();
  });

  it('serves the pool events query from the new index without a sort step', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const plan = queryPlan(db);
    expect(plan).toContain('USING INDEX lease_events_pool_at (pool=? AND at>?)');
    expect(plan).not.toContain('TEMP B-TREE');
    db.close();
  });
});
