import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestLeaseError } from '@testlease/protocol';
import { ManualClock, MonotonicClock } from '../../src/clock.js';
import { openDatabase } from '../../src/db/database.js';
import { currentSchemaVersion, migrate, migrations } from '../../src/db/migrations.js';
import type { TestLeaseEngine } from '../../src/testlease.js';
import { baseConfigInput, config, expectError, makeEngine, TEST_SECRETS } from '../helpers.js';
import { EnvSecretResolver } from '../../src/secrets/resolver.js';
import { createTestLease } from '../../src/testlease.js';

describe('migration 2 (v0.2)', () => {
  it('upgrades a v1 database in place and defaults renew_count to 0 for existing leases', () => {
    const db = openDatabase(':memory:');
    // Simulate a database created by v0.1: schema_migrations + migration 1 only.
    db.exec(
      `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT`,
    );
    db.exec(migrations[0]!.up);
    db.prepare(
      `INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'initial', ?)`,
    ).run(Date.now());
    const now = Date.now();
    db.prepare(
      `INSERT INTO pools (name, default_ttl_ms, max_ttl_ms, created_at, updated_at) VALUES ('p', 1000, 1000, ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO resources (id, pool, state, created_at, updated_at) VALUES ('r', 'p', 'AVAILABLE', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO leases (id, resource_id, pool, owner, principal, state, resource_snapshot_json, ttl_ms, created_at, expires_at, last_heartbeat_at, ended_at, end_reason)
      VALUES ('l1', 'r', 'p', 'o', 'local', 'RELEASED', '{"tags":{},"metadata":{},"secretRefs":{}}', 1000, ?, ?, ?, ?, 'RELEASED')`,
    ).run(now, now + 1000, now, now);
    expect(currentSchemaVersion(db)).toBe(1);

    const result = migrate(db);
    expect(result.applied).toEqual([2]);
    expect(currentSchemaVersion(db)).toBe(2);
    const row = db.prepare(`SELECT renew_count FROM leases WHERE id = 'l1'`).get() as {
      renew_count: number;
    };
    expect(row.renew_count).toBe(0);
    const indexes = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as { name: string }[]
    ).map((i) => i.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'lease_events_at',
        'leases_state_ended',
        'leases_one_active_per_resource',
      ]),
    );
    db.close();
  });
});

describe('MonotonicClock', () => {
  it('ignores wall-clock jumps in both directions while the process runs', () => {
    let wall = 1_000_000;
    let mono = 50_000;
    const clock = new MonotonicClock({ wall: () => wall, mono: () => mono });
    expect(clock.now()).toBe(1_000_000);
    mono += 10_000;
    wall += 10_000;
    expect(clock.now()).toBe(1_010_000);
    expect(clock.wallDriftMs()).toBe(0);
    wall += 3_600_000; // NTP jumps the system clock forward by an hour
    expect(clock.now()).toBe(1_010_000);
    expect(clock.wallDriftMs()).toBe(3_600_000);
    wall -= 7_200_000; // ...and then back two hours
    mono += 500;
    expect(clock.now()).toBe(1_010_500);
    expect(clock.wallDriftMs()).toBe(-3_600_500);
  });
});

describe('renew counting and history', () => {
  let clock: ManualClock;
  let engine: TestLeaseEngine;
  beforeEach(async () => {
    clock = new ManualClock();
    engine = await makeEngine({ clock });
  });
  afterEach(() => engine.close());

  it('counts renewals on the lease and records an event only when the TTL changes', async () => {
    const { lease } = await engine.service.acquire({ pool: 'buyers', owner: 'w' });
    expect(lease.renewCount).toBe(0);
    for (let i = 0; i < 3; i++) {
      clock.advance(1000);
      engine.service.renew(lease.leaseId, { owner: 'w' });
    }
    const view = engine.service.getLease(lease.leaseId);
    expect(view.renewCount).toBe(3);
    expect(view.lastHeartbeatAt).toBe(clock.now());
    expect(engine.service.listLeaseEvents(lease.leaseId).map((e) => e.type)).toEqual([
      'LEASE_ACQUIRED',
    ]);

    engine.service.renew(lease.leaseId, { owner: 'w', ttlMs: 120_000 });
    const events = engine.service.listLeaseEvents(lease.leaseId);
    expect(events.map((e) => e.type)).toEqual(['LEASE_ACQUIRED', 'LEASE_RENEWED']);
    expect(events[1]!.details).toMatchObject({ ttlMs: 120_000, renewCount: 4 });

    engine.service.recordRenewals = true;
    engine.service.renew(lease.leaseId, { owner: 'w' });
    expect(
      engine.service.listLeaseEvents(lease.leaseId).filter((e) => e.type === 'LEASE_RENEWED'),
    ).toHaveLength(2);
  });

  it('lists leases newest first with state/pool/owner filters', async () => {
    const a = await engine.service.acquire({ pool: 'buyers', owner: 'w1' });
    clock.advance(10);
    const b = await engine.service.acquire({ pool: 'buyers', owner: 'w2' });
    clock.advance(10);
    const c = await engine.service.acquire({ pool: 'admins', owner: 'w1' });
    engine.service.release(a.lease.leaseId, { owner: 'w1' });

    expect(engine.service.listLeases().map((l) => l.leaseId)).toEqual([
      c.lease.leaseId,
      b.lease.leaseId,
    ]);
    expect(engine.service.listLeases({ state: 'ALL' })).toHaveLength(3);
    expect(engine.service.listLeases({ state: 'RELEASED' }).map((l) => l.leaseId)).toEqual([
      a.lease.leaseId,
    ]);
    expect(engine.service.listLeases({ pool: 'admins' }).map((l) => l.leaseId)).toEqual([
      c.lease.leaseId,
    ]);
    expect(engine.service.listLeases({ state: 'ALL', owner: 'w1' }).map((l) => l.leaseId)).toEqual([
      c.lease.leaseId,
      a.lease.leaseId,
    ]);
    expect(engine.service.listLeases({ state: 'ALL', limit: 1 })).toHaveLength(1);
    expect(
      (await expectError<TestLeaseError>(() => engine.service.listLeases({ owner: 'has space' })))
        .code,
    ).toBe('INVALID_REQUEST');
  });

  it('prunes events and ended leases older than the retention, never active ones', async () => {
    const old = await engine.service.acquire({ pool: 'buyers', owner: 'old' });
    engine.service.release(old.lease.leaseId, { owner: 'old' });
    const live = await engine.service.acquire({ pool: 'buyers', owner: 'live', ttlMs: 3_600_000 });
    // A month of heartbeats every 30 minutes keeps the lease active while the clock passes retention.
    for (let i = 0; i < 31 * 48; i++) {
      clock.advance(30 * 60_000);
      engine.service.renew(live.lease.leaseId, { owner: 'live' });
    }
    const removed = engine.pruneHistory();
    expect(removed.leases).toBe(1);
    expect(removed.events).toBeGreaterThan(0);
    expect(engine.store.getLease(old.lease.leaseId)).toBeUndefined();
    expect(engine.service.getLease(live.lease.leaseId).state).toBe('ACTIVE');
    expect(engine.service.listLeaseEvents(live.lease.leaseId).map((e) => e.type)).toContain(
      'LEASE_ACQUIRED',
    );
    // Resource registration events older than retention are gone too (resources themselves stay).
    expect(engine.service.getResource('buyer-03').state).toBe('AVAILABLE');
  });
});

describe('configuration reload', () => {
  it('adds resources without restart, wakes waiters, warns about server.* changes', async () => {
    const input = baseConfigInput() as {
      pools: Record<string, { resources: { id: string; tags?: Record<string, string> }[] }>;
      server?: Record<string, unknown>;
    };
    const engine = await makeEngine({ configInput: input });
    try {
      const holders = await Promise.all(
        [1, 2, 3].map((i) => engine.service.acquire({ pool: 'buyers', owner: `h${i}` })),
      );
      const waiting = engine.service
        .acquire({ pool: 'buyers', owner: 'w', tags: { region: 'de' }, waitTimeoutMs: 5000 })
        .catch((e: TestLeaseError) => e);
      // region=de matches nothing yet -> NO_MATCHING_RESOURCE, which is immediate; use a pool-wide waiter instead.
      const result0 = await waiting;
      expect((result0 as TestLeaseError).code).toBe('NO_MATCHING_RESOURCE');
      const waiter = engine.service.acquire({ pool: 'buyers', owner: 'w', waitTimeoutMs: 5000 });
      expect(engine.service.getPool('buyers').waiting).toBe(1);

      input.pools.buyers!.resources.push({ id: 'buyer-04', tags: { region: 'de' } });
      input.server = { port: 5555 };
      const result = await engine.reload({ config: config(input) });
      expect(result.registered).toEqual(['buyer-04']);
      expect(result.warnings).toEqual(['server.port changed; requires a restart']);
      expect(result.reloads).toBe(1);
      const served = await waiter;
      expect(served.lease.resourceId).toBe('buyer-04');
      expect(engine.service.getPool('buyers').counts.total).toBe(4);
      expect((await engine.api.health()).config.reloads).toBe(1);
      for (const h of holders) engine.service.release(h.lease.leaseId, { owner: h.lease.owner });
    } finally {
      engine.close();
    }
  });

  it('rejects an invalid reload and keeps the running configuration', async () => {
    let attempt = 0;
    const engine = await createTestLease({
      config: config(),
      dbPath: ':memory:',
      secretResolvers: [new EnvSecretResolver(TEST_SECRETS)],
      configLoader: () => {
        attempt++;
        if (attempt === 1) throw new Error('bad.yml: resource id "x" is defined twice');
        const c = config();
        c.pools.buyers!.resources[0]!.secrets = { password: 'env:MISSING_ONE' };
        return { config: c, warnings: [], source: 'bad.yml' };
      },
    });
    try {
      const first = await expectError<TestLeaseError>(engine.reload());
      expect(first.code).toBe('CONFIG_INVALID');
      expect(first.message).toMatch(/defined twice/);
      const second = await expectError<TestLeaseError>(engine.reload());
      expect(second.code).toBe('CONFIG_INVALID');
      expect(second.message).toMatch(/MISSING_ONE/);
      expect(engine.service.getPool('buyers').counts.total).toBe(3);
      expect((await engine.api.health()).config.reloads).toBe(0);
      expect((await expectError<TestLeaseError>(engine.api.as('ops').reloadConfig())).code).toBe(
        'CONFIG_INVALID',
      );
    } finally {
      engine.close();
    }
  });
});

describe('pool-restricted principals', () => {
  it('cannot see or touch other pools, by name or through lease/resource ids', async () => {
    const engine = await makeEngine({});
    try {
      const ci = engine.api.as('ci', { pools: new Set(['buyers']) });
      expect((await ci.listPools()).map((p) => p.name)).toEqual(['buyers']);
      expect((await expectError<TestLeaseError>(ci.getPool('admins'))).code).toBe('FORBIDDEN');
      expect(
        (await expectError<TestLeaseError>(ci.acquire({ pool: 'admins', owner: 'x' }))).code,
      ).toBe('FORBIDDEN');
      const ok = await ci.acquire({ pool: 'buyers', owner: 'x' });
      expect(ok.lease.principal).toBe('ci');

      const admin = await engine.api.as('ops').acquire({ pool: 'admins', owner: 'ops' });
      for (const call of [
        () => ci.getLease(admin.lease.leaseId),
        () => ci.renew(admin.lease.leaseId, { owner: 'ops' }),
        () => ci.release(admin.lease.leaseId, { owner: 'ops' }),
        () => ci.listLeaseEvents(admin.lease.leaseId),
        () => ci.getResource('admin-01'),
        () => ci.listResourceEvents('admin-01'),
        () => ci.restoreResource('admin-01'),
        () => ci.resolveSecrets(admin.lease.leaseId, { owner: 'ops' }),
      ]) {
        const err = await expectError<TestLeaseError>(call);
        expect(err.code).toBe('FORBIDDEN');
        expect(err.details?.allowedPools).toEqual(['buyers']);
      }
      expect((await ci.listLeases({ state: 'ALL' })).leases.map((l) => l.pool)).toEqual(['buyers']);
      expect((await expectError<TestLeaseError>(ci.listLeases({ pool: 'admins' }))).code).toBe(
        'FORBIDDEN',
      );
      expect(engine.service.getLease(admin.lease.leaseId).state).toBe('ACTIVE');
    } finally {
      engine.close();
    }
  });
});
