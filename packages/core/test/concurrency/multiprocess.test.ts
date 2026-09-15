/**
 * Cross-process atomicity: N independent Node processes hammer the same SQLite file through the
 * built core package. This is deliberately *not* the supported topology (one server process owns
 * the waiting queue), but it proves that the database-level guarantees hold even when several
 * processes write concurrently — the unique partial index and BEGIN IMMEDIATE do the work.
 *
 * Requires `pnpm build` (uses packages/core/dist).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrations.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import { syncConfig } from '../../src/domain/config-sync.js';
import { assertNoOverlappingLeases, config, tempDir } from '../helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = join(here, '..', '..', 'dist', 'index.js');
const fixture = join(here, 'fixtures', 'hammer.mjs');

function runChild(
  dbPath: string,
  name: string,
  iterations: number,
): Promise<{
  acquired: number;
  denied: number;
  errors: number;
  stderr: string;
  code: number | null;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, dbPath, name, String(iterations)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.trim().split('\n').pop() ?? '{}';
      try {
        resolve({
          ...(JSON.parse(line) as { acquired: number; denied: number; errors: number }),
          stderr,
          code,
        });
      } catch {
        reject(
          new Error(
            `child ${name} produced no summary (code ${code}). stdout=${stdout} stderr=${stderr}`,
          ),
        );
      }
    });
  });
}

describe('multi-process acquisition on one SQLite file', () => {
  it('8 processes x 150 attempts on 5 resources: no double lease, no ownership loss', async () => {
    if (!existsSync(distEntry)) {
      throw new Error(
        `Built core not found at ${distEntry}. Run \`pnpm build\` before the concurrency suite.`,
      );
    }
    const { dir, cleanup } = tempDir();
    try {
      const dbPath = join(dir, 'shared.db');
      const db = openDatabase(dbPath);
      migrate(db);
      const store = new SqliteStore(db);
      syncConfig(
        store,
        config({
          pools: {
            accounts: { resources: Array.from({ length: 5 }, (_, i) => ({ id: `acct-${i + 1}` })) },
          },
        }),
        Date.now(),
      );
      db.close();

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => runChild(dbPath, `proc-${i + 1}`, 150)),
      );
      for (const r of results) {
        expect(r.code, r.stderr).toBe(0);
        expect(r.errors, r.stderr).toBe(0);
        expect(r.stderr).toBe('');
      }
      const totalAcquired = results.reduce((a, r) => a + r.acquired, 0);
      const totalDenied = results.reduce((a, r) => a + r.denied, 0);
      expect(totalAcquired).toBeGreaterThan(100);
      expect(totalDenied).toBeGreaterThan(0); // there was real contention

      const verify = openDatabase(dbPath);
      const vstore = new SqliteStore(verify);
      const events = vstore
        .recentEvents(1_000_000)
        .map((e) => ({
          seq: e.seq,
          type: e.type,
          resourceId: e.resourceId ?? undefined,
          leaseId: e.leaseId ?? undefined,
        }));
      const { perResource } = assertNoOverlappingLeases(events);
      expect(Object.values(perResource).reduce((a, b) => a + b, 0)).toBe(totalAcquired);
      expect(vstore.checkIntegrity()).toEqual([]);
      expect(vstore.listActiveLeases()).toEqual([]);
      const active = verify
        .prepare(`SELECT COUNT(*) AS n FROM leases WHERE state = 'ACTIVE'`)
        .get() as { n: number };
      expect(active.n).toBe(0);
      verify.close();
      console.log(
        `multiprocess: ${totalAcquired} acquisitions, ${totalDenied} denials across 8 processes; per resource: ${JSON.stringify(perResource)}`,
      );
    } finally {
      cleanup();
    }
  });
});
