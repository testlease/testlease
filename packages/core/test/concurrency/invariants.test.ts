/**
 * Core invariants under real concurrency (single process, real clock unless stated).
 * These are the tests that must be green before any adapter is built.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestLeaseError } from '@testlease/protocol';
import { ManualClock } from '../../src/clock.js';
import type { TestLeaseEngine } from '../../src/testlease.js';
import {
  assertNoOverlappingLeases,
  expectError,
  makeEngine,
  sleep,
  tempDir,
  waitFor,
} from '../helpers.js';

function fivePool(defaultTtl = '10m'): unknown {
  return {
    pools: {
      accounts: {
        defaultTtl,
        resources: Array.from({ length: 5 }, (_, i) => ({
          id: `acct-${i + 1}`,
          metadata: { slot: i + 1 },
        })),
      },
    },
  };
}

describe('invariant: never double-lease', () => {
  let engine: TestLeaseEngine;
  beforeEach(async () => {
    engine = await makeEngine({ configInput: fivePool() });
  });
  afterEach(() => engine.close());

  it('50 concurrent acquisitions on 5 resources: at most one active owner per resource at any moment', async () => {
    const holders = new Map<string, string>(); // resourceId -> owner currently using it
    const violations: string[] = [];
    let maxConcurrent = 0;
    const assignments: { owner: string; resourceId: string; waitedMs: number }[] = [];

    const work = async (i: number) => {
      const owner = `worker-${String(i).padStart(2, '0')}`;
      const res = await engine.service.acquire({ pool: 'accounts', owner, waitTimeoutMs: 30_000 });
      const rid = res.resource.id;
      // Application-level overlap detection, independent of the database.
      const current = holders.get(rid);
      if (current) violations.push(`${owner} received ${rid} while ${current} still held it`);
      holders.set(rid, owner);
      maxConcurrent = Math.max(maxConcurrent, holders.size);
      assignments.push({ owner, resourceId: rid, waitedMs: res.waitedMs });
      // Simulate a short test that yields to the event loop several times.
      await sleep(5 + Math.floor(Math.random() * 20));
      if (Math.random() < 0.5) engine.service.renew(res.lease.leaseId, { owner });
      await sleep(1 + Math.floor(Math.random() * 5));
      if (holders.get(rid) !== owner)
        violations.push(`${owner} lost ${rid} to ${holders.get(rid)} while using it`);
      holders.delete(rid);
      const released = engine.service.release(res.lease.leaseId, { owner });
      expect(released.outcome).toBe('released');
    };

    await Promise.all(Array.from({ length: 50 }, (_, i) => work(i + 1)));

    expect(violations).toEqual([]);
    expect(assignments).toHaveLength(50);
    expect(maxConcurrent).toBeLessThanOrEqual(5);
    expect(maxConcurrent).toBeGreaterThan(1); // it really was concurrent

    // Database-level evidence: the event log shows strictly alternating acquire/release per resource.
    const events = engine.store.recentEvents(10_000).map((e) => ({
      seq: e.seq,
      type: e.type,
      resourceId: e.resourceId ?? undefined,
      leaseId: e.leaseId ?? undefined,
    }));
    const { perResource } = assertNoOverlappingLeases(events);
    expect(Object.values(perResource).reduce((a, b) => a + b, 0)).toBe(50);
    expect(Object.keys(perResource).sort()).toEqual([
      'acct-1',
      'acct-2',
      'acct-3',
      'acct-4',
      'acct-5',
    ]);
    expect(engine.store.checkIntegrity()).toEqual([]);
    expect(engine.service.getPool('accounts').counts).toMatchObject({ available: 5, leased: 0 });
    expect(engine.service.getPool('accounts').waiting).toBe(0);

    // Waiters existed and were served: at least 45 acquisitions had to wait.
    expect(assignments.filter((a) => a.waitedMs > 0).length).toBeGreaterThanOrEqual(40);
  });

  it('tryAcquire hammered synchronously never hands out more than 5 leases', () => {
    const got: string[] = [];
    for (let i = 0; i < 200; i++) {
      const r = engine.service.tryAcquire({ pool: 'accounts', owner: `o${i}` });
      if (r) got.push(r.resource.id);
    }
    expect(got).toHaveLength(5);
    expect(new Set(got).size).toBe(5);
    expect(engine.store.checkIntegrity()).toEqual([]);
  });
});

describe('invariant: idempotent acquisition', () => {
  it('the same clientRequestId sent 10 times concurrently yields exactly one logical lease', async () => {
    const engine = await makeEngine({ configInput: fivePool() });
    try {
      const req = {
        pool: 'accounts',
        owner: 'gha-483/chromium/worker-2',
        clientRequestId: 'gha-483-chromium-worker-2',
        waitTimeoutMs: 5000,
      };
      const results = await Promise.all(
        Array.from({ length: 10 }, () => engine.service.acquire(req)),
      );
      const ids = new Set(results.map((r) => r.lease.leaseId));
      expect(ids.size).toBe(1);
      expect(results.filter((r) => !r.reused)).toHaveLength(1);
      expect(results.filter((r) => r.reused)).toHaveLength(9);
      expect(engine.service.getPool('accounts').counts.leased).toBe(1);
      const events = engine.service.listLeaseEvents([...ids][0]!);
      expect(events.filter((e) => e.type === 'LEASE_ACQUIRED')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'LEASE_REUSED')).toHaveLength(9);
      expect(engine.store.checkIntegrity()).toEqual([]);
    } finally {
      engine.close();
    }
  });

  it('retrying while waiting: both the original waiter and the retry receive the same lease', async () => {
    const engine = await makeEngine({
      configInput: { pools: { p: { resources: [{ id: 'only' }] } } },
    });
    try {
      const blocker = await engine.service.acquire({
        pool: 'p',
        owner: 'blocker',
        waitTimeoutMs: 0,
      });
      const req = { pool: 'p', owner: 'retrier', clientRequestId: 'same-key', waitTimeoutMs: 5000 };
      const first = engine.service.acquire(req);
      const retry = engine.service.acquire(req);
      expect(engine.service.getPool('p').waiting).toBe(2);
      engine.service.release(blocker.lease.leaseId, { owner: 'blocker' });
      const [a, b] = await Promise.all([first, retry]);
      expect(a.lease.leaseId).toBe(b.lease.leaseId);
      expect([a.reused, b.reused].sort()).toEqual([false, true]);
      expect(engine.store.checkIntegrity()).toEqual([]);
    } finally {
      engine.close();
    }
  });
});

describe('invariant: release is idempotent', () => {
  it('releasing twice (and concurrently) is harmless', async () => {
    const engine = await makeEngine({ configInput: fivePool() });
    try {
      const { lease } = await engine.service.acquire({
        pool: 'accounts',
        owner: 'w',
        waitTimeoutMs: 0,
      });
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () =>
          Promise.resolve().then(
            () => engine.service.release(lease.leaseId, { owner: 'w' }).outcome,
          ),
        ),
      );
      expect(outcomes.filter((o) => o === 'released')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'already_released')).toHaveLength(9);
      expect(
        engine.service.listLeaseEvents(lease.leaseId).filter((e) => e.type === 'LEASE_RELEASED'),
      ).toHaveLength(1);
      expect(engine.service.getResource(lease.resourceId).state).toBe('AVAILABLE');
      expect(engine.store.checkIntegrity()).toEqual([]);
    } finally {
      engine.close();
    }
  });
});

describe('invariant: expired leases are reclaimable, live leases are not', () => {
  it('crash recovery: a lease without heartbeats becomes available after its TTL (real clock)', async () => {
    const engine = await makeEngine({
      configInput: { pools: { p: { defaultTtl: '1s', resources: [{ id: 'only' }] } } },
    });
    try {
      const dead = await engine.service.acquire({
        pool: 'p',
        owner: 'crashed-worker',
        waitTimeoutMs: 0,
      });
      const blocked = await expectError<TestLeaseError>(
        engine.service.acquire({ pool: 'p', owner: 'next', waitTimeoutMs: 0 }),
      );
      expect(blocked.code).toBe('POOL_EXHAUSTED');
      await waitFor(() => engine.service.getResource('only').state === 'AVAILABLE', 3000);
      expect(engine.service.getLease(dead.lease.leaseId)).toMatchObject({
        state: 'EXPIRED',
        endReason: 'EXPIRED',
      });
      const next = await engine.service.acquire({ pool: 'p', owner: 'next', waitTimeoutMs: 0 });
      expect(next.resource.id).toBe('only');
      const types = engine.service.listResourceEvents('only').map((e) => e.type);
      expect(types).toEqual([
        'RESOURCE_REGISTERED',
        'LEASE_ACQUIRED',
        'LEASE_EXPIRED',
        'LEASE_ACQUIRED',
      ]);
    } finally {
      engine.close();
    }
  });

  it('healthy heartbeat: renewing before expiry keeps the resource unavailable to others well beyond the TTL', async () => {
    const engine = await makeEngine({
      configInput: { pools: { p: { defaultTtl: '1s', resources: [{ id: 'only' }] } } },
    });
    try {
      const live = await engine.service.acquire({ pool: 'p', owner: 'alive', waitTimeoutMs: 0 });
      const started = Date.now();
      let denied = 0;
      const heartbeat = setInterval(
        () => engine.service.renew(live.lease.leaseId, { owner: 'alive' }),
        300,
      );
      try {
        while (Date.now() - started < 2500) {
          // 2.5x the TTL
          const err = await expectError<TestLeaseError>(
            engine.service.acquire({ pool: 'p', owner: 'intruder', waitTimeoutMs: 0 }),
          );
          expect(err.code).toBe('POOL_EXHAUSTED');
          denied++;
          await sleep(100);
        }
      } finally {
        clearInterval(heartbeat);
      }
      expect(denied).toBeGreaterThan(15);
      expect(engine.service.getLease(live.lease.leaseId).state).toBe('ACTIVE');
      expect(engine.service.getResource('only').activeLease?.leaseId).toBe(live.lease.leaseId);
    } finally {
      engine.close();
    }
  });

  it('expiry is evaluated during acquire even if the sweeper never ran', async () => {
    const clock = new ManualClock();
    const engine = await makeEngine({
      configInput: { pools: { p: { defaultTtl: '1s', resources: [{ id: 'only' }] } } },
      clock,
    });
    try {
      engine.service.stop(); // no sweeper timer at all from here on
      // stop() rejects new acquisitions; use a fresh service on the same store to prove the
      // acquire path alone reclaims expired leases.
      const { LeaseService } = await import('../../src/domain/lease-service.js');
      const svc = new LeaseService({ store: engine.store, clock });
      const dead = await svc.acquire({ pool: 'p', owner: 'dead', waitTimeoutMs: 0 });
      clock.advance(1000);
      const next = await svc.acquire({ pool: 'p', owner: 'next', waitTimeoutMs: 0 });
      expect(next.resource.id).toBe('only');
      expect(svc.getLease(dead.lease.leaseId).state).toBe('EXPIRED');
      expect(engine.store.checkIntegrity()).toEqual([]);
    } finally {
      engine.close();
    }
  });
});

describe('invariant: quarantined resources are never acquired', () => {
  it('under concurrent load a quarantined resource is not handed out until restored', async () => {
    const engine = await makeEngine({ configInput: fivePool() });
    try {
      const first = await engine.service.acquire({
        pool: 'accounts',
        owner: 'q',
        waitTimeoutMs: 0,
      });
      engine.service.quarantine(first.lease.leaseId, { owner: 'q', reason: 'contaminated' });
      const quarantined = first.resource.id;

      const seen = new Set<string>();
      await Promise.all(
        Array.from({ length: 40 }, async (_, i) => {
          const r = await engine.service.acquire({
            pool: 'accounts',
            owner: `w${i}`,
            waitTimeoutMs: 10_000,
          });
          seen.add(r.resource.id);
          await sleep(3);
          engine.service.release(r.lease.leaseId, { owner: `w${i}` });
        }),
      );
      expect(seen.has(quarantined)).toBe(false);
      expect(seen.size).toBe(4);
      expect(engine.service.getResource(quarantined).state).toBe('QUARANTINED');

      engine.service.restoreResource(quarantined);
      const after = new Set<string>();
      await Promise.all(
        Array.from({ length: 10 }, async (_, i) => {
          const r = await engine.service.acquire({
            pool: 'accounts',
            owner: `r${i}`,
            waitTimeoutMs: 10_000,
          });
          after.add(r.resource.id);
          await sleep(3);
          engine.service.release(r.lease.leaseId, { owner: `r${i}` });
        }),
      );
      expect(after.has(quarantined)).toBe(true); // least-recently-leased ordering favours it now
      expect(engine.store.checkIntegrity()).toEqual([]);
    } finally {
      engine.close();
    }
  });
});

describe('invariant: restart keeps live leases', () => {
  it('a persisted live lease survives a restart; an overdue one is reclaimed on startup; quarantine persists', async () => {
    const { dir, cleanup } = tempDir();
    const clock = new ManualClock();
    try {
      const dbPath = `${dir}/tl.db`;
      const e1 = await makeEngine({ configInput: fivePool(), dbPath, clock });
      const live = await e1.service.acquire({
        pool: 'accounts',
        owner: 'w-live',
        ttlMs: 600_000,
        waitTimeoutMs: 0,
      });
      const doomed = await e1.service.acquire({
        pool: 'accounts',
        owner: 'w-doomed',
        ttlMs: 60_000,
        waitTimeoutMs: 0,
      });
      const q = await e1.service.acquire({ pool: 'accounts', owner: 'w-q', waitTimeoutMs: 0 });
      e1.service.quarantine(q.lease.leaseId, { owner: 'w-q', reason: 'broken' });
      e1.close(); // shutdown must NOT release anything

      clock.advance(120_000); // the 60s lease is now overdue, the 10m one is not

      const e2 = await makeEngine({ configInput: fivePool(), dbPath, clock });
      expect(e2.service.getLease(live.lease.leaseId).state).toBe('ACTIVE');
      expect(e2.service.getResource(live.resource.id).activeLease?.owner).toBe('w-live');
      expect(e2.service.getLease(doomed.lease.leaseId).state).toBe('EXPIRED');
      expect(e2.service.getResource(doomed.resource.id).state).toBe('AVAILABLE');
      expect(e2.service.getResource(q.resource.id).state).toBe('QUARANTINED');
      expect(e2.service.getPool('accounts').counts).toEqual({
        available: 3,
        leased: 1,
        quarantined: 1,
        disabled: 0,
        total: 5,
      });

      // The surviving owner can still renew and release with the same owner string.
      e2.service.renew(live.lease.leaseId, { owner: 'w-live' });
      expect(e2.service.release(live.lease.leaseId, { owner: 'w-live' }).outcome).toBe('released');
      expect(e2.store.checkIntegrity()).toEqual([]);
      e2.close();
    } finally {
      cleanup();
    }
  });
});

describe('invariant: release/acquire races keep ownership consistent', () => {
  it('interleaved releases and acquisitions across 1 resource and many actors', async () => {
    const engine = await makeEngine({
      configInput: { pools: { p: { resources: [{ id: 'hot' }] } } },
    });
    try {
      let concurrentHolders = 0;
      let maxHolders = 0;
      const actors = Array.from({ length: 30 }, async (_, i) => {
        for (let round = 0; round < 3; round++) {
          const r = await engine.service.acquire({
            pool: 'p',
            owner: `a${i}`,
            waitTimeoutMs: 30_000,
          });
          concurrentHolders++;
          maxHolders = Math.max(maxHolders, concurrentHolders);
          await sleep(Math.random() * 3);
          concurrentHolders--;
          // Fire release and an immediate re-acquire attempt without awaiting in between.
          const rel = engine.service.release(r.lease.leaseId, { owner: `a${i}` });
          expect(rel.outcome).toBe('released');
          const stale = engine.service.release(r.lease.leaseId, { owner: `a${i}` });
          expect(stale.outcome).toBe('already_released');
        }
      });
      await Promise.all(actors);
      expect(maxHolders).toBe(1);
      const events = engine.store
        .recentEvents(10_000)
        .map((e) => ({
          seq: e.seq,
          type: e.type,
          resourceId: e.resourceId ?? undefined,
          leaseId: e.leaseId ?? undefined,
        }));
      expect(assertNoOverlappingLeases(events).perResource).toEqual({ hot: 90 });
      expect(engine.store.checkIntegrity()).toEqual([]);
    } finally {
      engine.close();
    }
  });
});
