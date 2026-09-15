import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export type SqliteDatabase = Database.Database;

export interface OpenDatabaseOptions {
  /** Milliseconds to wait on SQLITE_BUSY before failing (cross-process contention). */
  busyTimeoutMs?: number;
  readonly?: boolean;
}

/**
 * Opens (and creates) the SQLite database with the pragmas TestLease relies on:
 * WAL for concurrent readers, foreign keys on, and a busy timeout so that a second process
 * (e.g. a CLI pointed at the same file) waits instead of failing immediately.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): SqliteDatabase {
  const isMemory = path === ':memory:' || path === '';
  if (!isMemory) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(isMemory ? ':memory:' : path, {
    timeout: options.busyTimeoutMs ?? 5_000,
    readonly: options.readonly ?? false,
  });
  if (!isMemory && !options.readonly) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
  return db;
}
