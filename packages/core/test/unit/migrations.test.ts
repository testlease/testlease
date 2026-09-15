import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { currentSchemaVersion, migrate, migrations } from '../../src/db/migrations.js';
import { join } from 'node:path';
import { tempDir } from '../helpers.js';

describe('migrations', () => {
  it('applies all migrations to a fresh database and is idempotent', () => {
    const db = openDatabase(':memory:');
    expect(currentSchemaVersion(db)).toBe(0);
    const first = migrate(db);
    expect(first.applied).toEqual(migrations.map((m) => m.version));
    expect(first.version).toBe(Math.max(...migrations.map((m) => m.version)));
    const second = migrate(db);
    expect(second.applied).toEqual([]);
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(['pools', 'resources', 'leases', 'lease_events', 'schema_migrations']),
    );
    db.close();
  });

  it('enforces one ACTIVE lease per resource at the database level', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO pools (name, default_ttl_ms, max_ttl_ms, created_at, updated_at) VALUES ('p', 1000, 1000, ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO resources (id, pool, state, created_at, updated_at) VALUES ('r', 'p', 'AVAILABLE', ?, ?)`,
    ).run(now, now);
    const insert =
      db.prepare(`INSERT INTO leases (id, resource_id, pool, owner, state, ttl_ms, created_at, expires_at, last_heartbeat_at)
      VALUES (?, 'r', 'p', 'o', 'ACTIVE', 1000, ?, ?, ?)`);
    insert.run('l1', now, now + 1000, now);
    expect(() => insert.run('l2', now, now + 1000, now)).toThrow(/UNIQUE constraint failed/);
    // Ending the first lease frees the slot.
    db.prepare(
      `UPDATE leases SET state='RELEASED', ended_at=?, end_reason='RELEASED' WHERE id='l1'`,
    ).run(now);
    expect(() => insert.run('l2', now, now + 1000, now)).not.toThrow();
    db.close();
  });

  it('enforces one ACTIVE lease per client request id', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO pools (name, default_ttl_ms, max_ttl_ms, created_at, updated_at) VALUES ('p', 1000, 1000, ?, ?)`,
    ).run(now, now);
    for (const id of ['r1', 'r2']) {
      db.prepare(
        `INSERT INTO resources (id, pool, state, created_at, updated_at) VALUES (?, 'p', 'AVAILABLE', ?, ?)`,
      ).run(id, now, now);
    }
    const insert =
      db.prepare(`INSERT INTO leases (id, resource_id, pool, owner, state, client_request_id, ttl_ms, created_at, expires_at, last_heartbeat_at)
      VALUES (?, ?, 'p', 'o', 'ACTIVE', 'req-1', 1000, ?, ?, ?)`);
    insert.run('l1', 'r1', now, now + 1000, now);
    expect(() => insert.run('l2', 'r2', now, now + 1000, now)).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  it('rejects inconsistent resource rows via CHECK constraints', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO pools (name, default_ttl_ms, max_ttl_ms, created_at, updated_at) VALUES ('p', 1000, 1000, ?, ?)`,
    ).run(now, now);
    expect(() =>
      db
        .prepare(
          `INSERT INTO resources (id, pool, state, created_at, updated_at) VALUES ('r', 'p', 'LEASED', ?, ?)`,
        )
        .run(now, now),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO resources (id, pool, state, created_at, updated_at) VALUES ('r', 'p', 'QUARANTINED', ?, ?)`,
        )
        .run(now, now),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('persists to a file and reports the version after reopening', () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, 'tl.db');
      const db = openDatabase(path);
      migrate(db);
      db.close();
      const again = openDatabase(path);
      expect(currentSchemaVersion(again)).toBe(1);
      expect(again.pragma('journal_mode', { simple: true })).toBe('wal');
      again.close();
    } finally {
      cleanup();
    }
  });
});
