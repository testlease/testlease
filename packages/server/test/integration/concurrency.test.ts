/**
 * Black-box concurrency over real HTTP: many independent clients, one server, five resources.
 * Proves the remote lifecycle end to end: waiting, fairness, cancellation, crash recovery,
 * restart, shutdown — with zero overlap and zero leaked waiters or ghost leases.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestLeaseError } from '@testlease/protocol';
import { TestLeaseClient } from '@testlease/client';
import {
  assertNoOverlappingLeases,
  buyersConfig,
  expectError,
  sleep,
  startTestServer,
  tempDir,
  waitFor,
  type TestServer,
} from '../helpers.js';

function fivePool(defaultTtl = '10m', maxWait = '60s'): Record<string, unknown> {
  return {
    server: { host: '127.0.0.1', port: 0, db: ':memory:', maxWait, logLevel: 'silent' },
    pools: {
      accounts: {
        defaultTtl,
        resources: Array.from({ length: 5 }, (_, i) => ({ id: `acct-${i + 1}` })),
      },
    },
  };
}

describe('HTTP concurrency', () => {
  let ts: TestServer | undefined;
  afterEach(async () => {
    await ts?.close();
    ts = undefined;
  });

  it('50 concurrent HTTP clients, 5 resources, waiting enabled: 50 acquisitions, 0 overlap, 0 leaked waiters', async () => {
    ts = await startTestServer({ configInput: fivePool() });
    const holders = new Map<string, string>();
    const violations: string[] = [];
    let maxConcurrent = 0;
    let waited = 0;

    const worker = async (i: number) => {
      const owner = `run-7/chromium/worker-${String(i).padStart(2, '0')}`;
      // Each worker is its own client instance (own connection pool), like separate processes.
      const client = new TestLeaseClient({ baseUrl: ts!.url, owner, requestTimeoutMs: 5_000 });
      const lease = await client.acquireLease({
        pool: 'accounts',
        waitTimeoutMs: 30_000,
        heartbeat: false,
      });
      if (lease.view.state !== 'ACTIVE') violations.push(`${owner} got non-active lease`);
      const rid = lease.resourceId;
      const current = holders.get(rid);
      if (current) violations.push(`${owner} received ${rid} while ${current} held it`);
      holders.set(rid, owner);
      maxConcurrent = Math.max(maxConcurrent, holders.size);
      await sleep(10 + Math.random() * 30);
      if (Math.random() < 0.5) await lease.renew();
      if (holders.get(rid) !== owner) violations.push(`${owner} lost ${rid}`);
      holders.delete(rid);
      const rel = await lease.release();
      if (rel.outcome !== 'released') violations.push(`${owner} release outcome ${rel.outcome}`);
      return lease;
    };

    const leases = await Promise.all(Array.from({ length: 50 }, (_, i) => worker(i + 1)));
    expect(violations).toEqual([]);
    expect(leases).toHaveLength(50);
    expect(maxConcurrent).toBeLessThanOrEqual(5);
    expect(maxConcurrent).toBeGreaterThan(1);

    const admin = ts.client();
    const pool = await admin.getPool('accounts');
    expect(pool.counts).toMatchObject({ available: 5, leased: 0 });
    expect(pool.waiting).toBe(0); // no leaked waiters
    expect(ts.engine.service.waitingCount).toBe(0);

    const { events } = await admin.listRecentEvents(1000);
    const perResource = assertNoOverlappingLeases(
      events.map((e) => ({
        seq: e.seq,
        type: e.type,
        resourceId: e.resourceId,
        leaseId: e.leaseId,
      })),
    );
    expect(Object.values(perResource).reduce((a, b) => a + b, 0)).toBe(50);
    for (const e of events.filter((e) => e.type === 'LEASE_ACQUIRED')) {
      if ((e.details?.waitedMs as number) > 0) waited++;
    }
    expect(waited).toBeGreaterThanOrEqual(40);
    expect(ts.engine.store.checkIntegrity()).toEqual([]);
  });

  it('client cancellation while waiting leaves no ghost lease', async () => {
    ts = await startTestServer({ configInput: fivePool() });
    const client = ts.client({ owner: 'holder' });
    const held = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        client.acquire({ pool: 'accounts', owner: `holder-${i}` }),
      ),
    );

    // 10 waiters connect over HTTP, then 7 of them disconnect (fetch abort => socket destroyed).
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const waiters = controllers.map((ac, i) =>
      new TestLeaseClient({ baseUrl: ts!.url, requestTimeoutMs: 5_000, retries: 0 })
        .acquire(
          { pool: 'accounts', owner: `waiter-${i}`, waitTimeoutMs: 20_000 },
          { signal: ac.signal },
        )
        .then((r) => ({ ok: true as const, r, i }))
        .catch((e: TestLeaseError) => ({ ok: false as const, code: e.code, i })),
    );
    await waitFor(() => ts!.engine.service.waitingCount === 10, 5000);
    for (const i of [0, 1, 2, 4, 6, 7, 9]) controllers[i]!.abort();
    await waitFor(() => ts!.engine.service.waitingCount === 3, 5000);

    // Free all five resources: only the 3 live waiters may receive one.
    for (const h of held) await client.release(h.lease.leaseId, { owner: h.lease.owner });
    const results = await Promise.all(waiters);
    const served = results.filter((r) => r.ok);
    expect(served.map((r) => r.i).sort()).toEqual([3, 5, 8]);
    expect(results.filter((r) => !r.ok).every((r) => r.code === 'ACQUIRE_ABORTED')).toBe(true);

    const pool = await client.getPool('accounts');
    expect(pool.counts).toMatchObject({ leased: 3, available: 2 });
    expect(pool.waiting).toBe(0);
    // No lease exists for any aborted waiter: nothing is occupied that nobody owns.
    const owners = pool.resources
      .filter((r) => r.activeLease)
      .map((r) => r.activeLease!.owner)
      .sort();
    expect(owners).toEqual(['waiter-3', 'waiter-5', 'waiter-8']);
    expect(ts.engine.store.checkIntegrity()).toEqual([]);
  });

  it('a client that dies without releasing loses its lease after the TTL; a heartbeating client keeps it', async () => {
    ts = await startTestServer({ configInput: fivePool('1s') });
    const dead = ts.client({ owner: 'dead' });
    const alive = ts.client({ owner: 'alive' });
    const deadLease = await dead.acquireLease({ pool: 'accounts', heartbeat: false });
    const liveLease = await alive.acquireLease({
      pool: 'accounts',
      heartbeat: { intervalMs: 250 },
    });
    await sleep(2_600);
    expect((await ts.client().getLease(deadLease.leaseId)).state).toBe('EXPIRED');
    expect((await ts.client().getLease(liveLease.leaseId)).state).toBe('ACTIVE');
    expect(liveLease.heartbeat.renewals).toBeGreaterThanOrEqual(6);
    expect(liveLease.heartbeat.healthy).toBe(true);
    expect((await liveLease.release()).outcome).toBe('released');
    // The dead handle learns about its fate on release and reports it in evidence.
    const rel = await deadLease.release();
    expect(rel.outcome).toBe('already_expired');
    expect(deadLease.evidence()).toMatchObject({ state: 'EXPIRED', expiredDuringUse: true });
  });

  it('heartbeat handle stops itself when the server says the lease is gone', async () => {
    ts = await startTestServer({ configInput: fivePool('2s') });
    const client = ts.client({ owner: 'w' });
    const errors: string[] = [];
    const lease = await client.acquireLease({
      pool: 'accounts',
      heartbeat: { intervalMs: 200, onError: (e) => errors.push((e as TestLeaseError).code) },
    });
    // An operator force-releases it from the outside.
    await ts.client().release(lease.leaseId, { owner: 'ops', force: true });
    await waitFor(() => !lease.heartbeat.running, 3000);
    expect(errors).toContain('LEASE_NOT_ACTIVE');
    expect(lease.heartbeat.healthy).toBe(false);
    expect(lease.heartbeat.lastError?.code).toBe('LEASE_NOT_ACTIVE');
  });

  it('server restart keeps active leases and lets the same owner+principal continue', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const dbPath = join(dir, 'tl.db');
      ts = await startTestServer({ configInput: buyersConfig(), dbPath });
      const client = ts.client({ owner: 'gha-9/w1' });
      const lease = await client.acquireLease({
        pool: 'buyers',
        tags: { region: 'be' },
        heartbeat: false,
      });
      const waiting = ts
        .client({ owner: 'gha-9/w2', retries: 0 })
        .acquire({
          pool: 'buyers',
          owner: 'gha-9/w2',
          tags: { region: 'be' },
          waitTimeoutMs: 20_000,
        })
        .catch((e: TestLeaseError) => e);
      await waitFor(() => ts!.engine.service.waitingCount === 1, 5000);
      await ts.close(); // graceful: waiter gets SERVER_SHUTTING_DOWN, lease is kept
      const waitErr = (await waiting) as TestLeaseError;
      expect(waitErr.code).toBe('SERVER_SHUTTING_DOWN');

      ts = await startTestServer({ configInput: buyersConfig(), dbPath });
      const again = ts.client({ owner: 'gha-9/w1' });
      const view = await again.getLease(lease.leaseId);
      expect(view.state).toBe('ACTIVE');
      expect(view.resource.metadata.email).toBe('buyer03@example.test');
      const stillBlocked = await expectError<TestLeaseError>(
        ts.client().acquire({ pool: 'buyers', owner: 'x', tags: { region: 'be' } }),
      );
      expect(stillBlocked.code).toBe('POOL_EXHAUSTED');
      const renewed = await again.renew(lease.leaseId, { owner: 'gha-9/w1' });
      expect(renewed.lease.state).toBe('ACTIVE');
      expect((await again.release(lease.leaseId, { owner: 'gha-9/w1' })).outcome).toBe('released');
    } finally {
      cleanup();
    }
  });

  it('a lost response is safe: retrying the same clientRequestId returns the same lease', async () => {
    ts = await startTestServer({ configInput: fivePool() });
    const client = ts.client({ owner: 'retry' });
    const req = { pool: 'accounts', owner: 'retry', clientRequestId: 'gha-1-chromium-worker-3' };
    const [a, b, c] = await Promise.all([
      client.acquire(req),
      client.acquire(req),
      client.acquire(req),
    ]);
    expect(new Set([a.lease.leaseId, b.lease.leaseId, c.lease.leaseId]).size).toBe(1);
    expect([a, b, c].filter((r) => r.reused)).toHaveLength(2);
    expect((await client.getPool('accounts')).counts.leased).toBe(1);
  });

  it('the client reports UNAVAILABLE with a hint when the server is down', async () => {
    const client = new TestLeaseClient({
      baseUrl: 'http://127.0.0.1:1',
      requestTimeoutMs: 1000,
      retries: 1,
    });
    const err = await expectError<TestLeaseError>(client.listPools());
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toMatch(/Cannot reach TestLease at http:\/\/127.0.0.1:1/);
    expect(err.message).toMatch(/testlease doctor/);
  });
});
