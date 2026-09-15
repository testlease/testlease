import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestLeaseError } from '@testlease/protocol';
import { ManualClock } from '../../src/clock.js';
import type { TestLeaseEngine } from '../../src/testlease.js';
import { baseConfigInput, expectError, makeEngine } from '../helpers.js';

const OWNER = 'run-1/chromium/worker-1';
const OTHER = 'run-1/chromium/worker-2';

describe('LeaseService state machine', () => {
  let clock: ManualClock;
  let engine: TestLeaseEngine;

  beforeEach(async () => {
    clock = new ManualClock();
    engine = await makeEngine({ clock });
  });
  afterEach(() => engine.close());

  it('acquires the least recently used matching resource and records evidence', async () => {
    const res = await engine.service.acquire({
      pool: 'buyers',
      owner: OWNER,
      tags: { region: 'nl' },
      waitTimeoutMs: 0,
      purpose: 'checkout smoke',
    });
    expect(res.reused).toBe(false);
    expect(res.resource.id).toBe('buyer-01');
    expect(res.resource.state).toBe('LEASED');
    expect(res.resource.secretKeys).toEqual(['password']);
    expect(JSON.stringify(res)).not.toContain('hunter2');
    expect(res.lease.owner).toBe(OWNER);
    expect(res.lease.ttlMs).toBe(600_000);
    expect(res.lease.expiresAt).toBe(clock.now() + 600_000);
    expect(res.lease.purpose).toBe('checkout smoke');

    const events = engine.service.listLeaseEvents(res.lease.leaseId);
    expect(events.map((e) => e.type)).toEqual(['LEASE_ACQUIRED']);
    expect(events[0]!.details).toMatchObject({
      ttlMs: 600_000,
      waitedMs: 0,
      tags: { region: 'nl' },
      purpose: 'checkout smoke',
    });

    const pool = engine.service.getPool('buyers');
    expect(pool.counts).toEqual({ available: 2, leased: 1, quarantined: 0, disabled: 0, total: 3 });
    expect(pool.resources.find((r) => r.id === 'buyer-01')!.activeLease).toMatchObject({
      leaseId: res.lease.leaseId,
      owner: OWNER,
    });
  });

  it('rotates through resources: least recently leased first, ties by id', async () => {
    const a = await engine.service.acquire({ pool: 'buyers', owner: OWNER, waitTimeoutMs: 0 });
    expect(a.resource.id).toBe('buyer-01');
    engine.service.release(a.lease.leaseId, { owner: OWNER });
    clock.advance(1000);
    const b = await engine.service.acquire({ pool: 'buyers', owner: OWNER, waitTimeoutMs: 0 });
    expect(b.resource.id).toBe('buyer-02'); // never leased yet -> preferred over buyer-01
    const c = await engine.service.acquire({ pool: 'buyers', owner: OWNER, waitTimeoutMs: 0 });
    expect(c.resource.id).toBe('buyer-03');
    const d = await engine.service.acquire({ pool: 'buyers', owner: OWNER, waitTimeoutMs: 0 });
    expect(d.resource.id).toBe('buyer-01'); // the only free one, leased longest ago
  });

  it('matching is deterministic and reports why nothing matches', async () => {
    const err = await expectError<TestLeaseError>(
      engine.service.acquire({
        pool: 'buyers',
        owner: OWNER,
        tags: { region: 'de' },
        waitTimeoutMs: 0,
      }),
    );
    expect(err.code).toBe('NO_MATCHING_RESOURCE');
    expect(err.message).toMatch(/matches region=de/);
    expect(err.message).toMatch(/Known values: region: be, nl/);
    expect(err.details).toMatchObject({ resourceCount: 3, knownValues: { region: ['be', 'nl'] } });

    const missingKey = await expectError<TestLeaseError>(
      engine.service.acquire({
        pool: 'buyers',
        owner: OWNER,
        tags: { tier: 'gold' },
        waitTimeoutMs: 0,
      }),
    );
    expect(missingKey.message).toMatch(/no resource defines this key/);

    const unknownPool = await expectError<TestLeaseError>(
      engine.service.acquire({ pool: 'nope', owner: OWNER }),
    );
    expect(unknownPool.code).toBe('POOL_NOT_FOUND');
    expect(unknownPool.message).toMatch(/Known pools: admins, buyers/);
  });

  it('fails fast with POOL_EXHAUSTED and a full diagnostic when waitTimeoutMs is 0', async () => {
    const first = await engine.service.acquire({
      pool: 'buyers',
      owner: OWNER,
      tags: { paymentMethod: 'ideal' },
      waitTimeoutMs: 0,
      purpose: 'checkout',
    });
    const second = await engine.service.acquire({
      pool: 'buyers',
      owner: OTHER,
      tags: { paymentMethod: 'ideal' },
      waitTimeoutMs: 0,
    });
    expect([first.resource.id, second.resource.id].sort()).toEqual(['buyer-01', 'buyer-03']);
    clock.advance(30_000);

    const err = await expectError<TestLeaseError>(
      engine.service.acquire({
        pool: 'buyers',
        owner: 'run-1/chromium/worker-3',
        tags: { paymentMethod: 'ideal' },
        waitTimeoutMs: 0,
      }),
    );
    expect(err.code).toBe('POOL_EXHAUSTED');
    expect(err.message).toContain('Pool: buyers');
    expect(err.message).toContain('paymentMethod=ideal');
    expect(err.message).toMatch(
      /buyer-01\s+LEASED\s+owner=run-1\/chromium\/worker-1\s+expires in 09:30\s+\(checkout\)/,
    );
    expect(err.message).toMatch(/buyer-02\s+AVAILABLE\s+\[does not match tags\]/);
    expect(err.message).toContain('Waiters: none');
    expect(err.message).not.toContain('hunter2');
    expect(err.details).toMatchObject({ pool: 'buyers', waitedMs: 0, waiters: 0 });
  });

  it('renews only for the owner and moves the expiry forward', async () => {
    const { lease } = await engine.service.acquire({
      pool: 'buyers',
      owner: OWNER,
      waitTimeoutMs: 0,
    });
    clock.advance(60_000);
    const renewed = engine.service.renew(lease.leaseId, { owner: OWNER });
    expect(renewed.lease.expiresAt).toBe(clock.now() + 600_000);
    expect(renewed.lease.lastHeartbeatAt).toBe(clock.now());

    const mismatch = await expectError<TestLeaseError>(() =>
      engine.service.renew(lease.leaseId, { owner: OTHER }),
    );
    expect(mismatch.code).toBe('LEASE_OWNERSHIP_MISMATCH');
    expect(mismatch.message).toContain(`owned by "${OWNER}", not "${OTHER}"`);

    const tooLong = await expectError<TestLeaseError>(() =>
      engine.service.renew(lease.leaseId, { owner: OWNER, ttlMs: 2 * 3_600_000 }),
    );
    expect(tooLong.code).toBe('INVALID_REQUEST');
    expect(tooLong.message).toMatch(/exceeds the maximum TTL 1h/);

    const events = engine.service.listLeaseEvents(lease.leaseId).map((e) => e.type);
    expect(events).toEqual(['LEASE_ACQUIRED', 'LEASE_RENEWED']);
  });

  it('release is idempotent and ownership-aware', async () => {
    const { lease } = await engine.service.acquire({
      pool: 'buyers',
      owner: OWNER,
      waitTimeoutMs: 0,
    });
    const mismatch = await expectError<TestLeaseError>(() =>
      engine.service.release(lease.leaseId, { owner: OTHER }),
    );
    expect(mismatch.code).toBe('LEASE_OWNERSHIP_MISMATCH');

    clock.advance(5000);
    const first = engine.service.release(lease.leaseId, { owner: OWNER });
    expect(first.outcome).toBe('released');
    expect(first.lease.state).toBe('RELEASED');
    expect(first.lease.endReason).toBe('RELEASED');
    expect(first.lease.endedAt).toBe(clock.now());
    expect(engine.service.getResource('buyer-01').state).toBe('AVAILABLE');

    const second = engine.service.release(lease.leaseId, { owner: OWNER });
    expect(second.outcome).toBe('already_released');
    // A different owner releasing an already-ended lease is harmless.
    expect(engine.service.release(lease.leaseId, { owner: OTHER }).outcome).toBe(
      'already_released',
    );
    expect(
      engine.service.listLeaseEvents(lease.leaseId).filter((e) => e.type === 'LEASE_RELEASED'),
    ).toHaveLength(1);
    expect(engine.store.checkIntegrity()).toEqual([]);
  });

  it('force release bypasses ownership and is recorded as such', async () => {
    const { lease } = await engine.service.acquire({
      pool: 'buyers',
      owner: OWNER,
      waitTimeoutMs: 0,
    });
    const res = engine.service.release(lease.leaseId, { owner: 'cli:ops', force: true });
    expect(res.outcome).toBe('released');
    expect(res.lease.endReason).toBe('FORCE_RELEASED');
    const ev = engine.service
      .listLeaseEvents(lease.leaseId)
      .find((e) => e.type === 'LEASE_RELEASED')!;
    expect(ev.details).toMatchObject({ force: true, by: 'cli:ops' });
  });

  it('expired leases are reclaimable; renew/release after expiry report LEASE_EXPIRED', async () => {
    const { lease } = await engine.service.acquire({
      pool: 'buyers',
      owner: OWNER,
      tags: { region: 'be' },
      waitTimeoutMs: 0,
    });
    clock.advance(600_000); // exactly at expiry -> due
    expect(engine.service.getLease(lease.leaseId).state).toBe('EXPIRED');
    expect(engine.service.getResource('buyer-03').state).toBe('AVAILABLE');

    const renew = await expectError<TestLeaseError>(() =>
      engine.service.renew(lease.leaseId, { owner: OWNER }),
    );
    expect(renew.code).toBe('LEASE_EXPIRED');

    const next = await engine.service.acquire({
      pool: 'buyers',
      owner: OTHER,
      tags: { region: 'be' },
      waitTimeoutMs: 0,
    });
    expect(next.resource.id).toBe('buyer-03');
    expect(next.lease.leaseId).not.toBe(lease.leaseId);

    const renewAgain = await expectError<TestLeaseError>(() =>
      engine.service.renew(lease.leaseId, { owner: OWNER }),
    );
    expect(renewAgain.message).toContain(`is now leased by "${OTHER}"`);
    expect(engine.service.release(lease.leaseId, { owner: OWNER }).outcome).toBe('already_expired');
    // The stale owner's release must not have touched the successor.
    expect(engine.service.getLease(next.lease.leaseId).state).toBe('ACTIVE');
    expect(engine.service.getResource('buyer-03').activeLease?.leaseId).toBe(next.lease.leaseId);

    const types = engine.service.listLeaseEvents(lease.leaseId).map((e) => e.type);
    expect(types).toEqual(['LEASE_ACQUIRED', 'LEASE_EXPIRED']);
  });

  it('renew racing with expiry cannot resurrect a lease', async () => {
    const { lease } = await engine.service.acquire({
      pool: 'buyers',
      owner: OWNER,
      waitTimeoutMs: 0,
    });
    clock.advance(600_000);
    // Nobody has observed the expiry yet; the renew itself must detect it.
    const err = await expectError<TestLeaseError>(() =>
      engine.service.renew(lease.leaseId, { owner: OWNER }),
    );
    expect(err.code).toBe('LEASE_EXPIRED');
    expect(engine.service.getLease(lease.leaseId).state).toBe('EXPIRED');
    expect(engine.service.getResource('buyer-01').state).toBe('AVAILABLE');
  });

  it('a renewed lease does not expire at its original deadline', async () => {
    const { lease } = await engine.service.acquire({
      pool: 'buyers',
      owner: OWNER,
      waitTimeoutMs: 0,
    });
    for (let i = 0; i < 5; i++) {
      clock.advance(400_000);
      engine.service.renew(lease.leaseId, { owner: OWNER });
    }
    expect(engine.service.getLease(lease.leaseId).state).toBe('ACTIVE');
    expect(engine.service.expireDue()).toEqual([]);
  });

  it('quarantine ends the lease, blocks the resource and restore makes it eligible again', async () => {
    const { lease } = await engine.service.acquire({
      pool: 'buyers',
      owner: OWNER,
      tags: { region: 'be' },
      waitTimeoutMs: 0,
    });
    const q = engine.service.quarantine(lease.leaseId, { owner: OWNER, reason: 'account locked' });
    expect(q.lease.state).toBe('RELEASED');
    expect(q.lease.endReason).toBe('QUARANTINED');
    expect(q.resource.state).toBe('QUARANTINED');
    expect(q.resource.quarantine).toMatchObject({ reason: 'account locked', by: OWNER });

    const err = await expectError<TestLeaseError>(
      engine.service.acquire({
        pool: 'buyers',
        owner: OTHER,
        tags: { region: 'be' },
        waitTimeoutMs: 0,
      }),
    );
    expect(err.code).toBe('POOL_EXHAUSTED');
    expect(err.message).toMatch(/buyer-03\s+QUARANTINED\s+account locked/);

    const notQ = await expectError<TestLeaseError>(() =>
      engine.service.restoreResource('buyer-01'),
    );
    expect(notQ.code).toBe('RESOURCE_NOT_QUARANTINED');

    const restored = engine.service.restoreResource('buyer-03');
    expect(restored.resource.state).toBe('AVAILABLE');
    expect(restored.resource.quarantine).toBeUndefined();
    const again = await engine.service.acquire({
      pool: 'buyers',
      owner: OTHER,
      tags: { region: 'be' },
      waitTimeoutMs: 0,
    });
    expect(again.resource.id).toBe('buyer-03');

    const types = engine.service.listResourceEvents('buyer-03').map((e) => e.type);
    expect(types).toEqual([
      'RESOURCE_REGISTERED',
      'LEASE_ACQUIRED',
      'LEASE_RELEASED',
      'RESOURCE_QUARANTINED',
      'RESOURCE_RESTORED',
      'LEASE_ACQUIRED',
    ]);
  });

  it('quarantine of an expired lease is refused (the resource may have moved on)', async () => {
    const { lease } = await engine.service.acquire({
      pool: 'buyers',
      owner: OWNER,
      waitTimeoutMs: 0,
    });
    clock.advance(700_000);
    const err = await expectError<TestLeaseError>(() =>
      engine.service.quarantine(lease.leaseId, { owner: OWNER, reason: 'late' }),
    );
    expect(err.code).toBe('LEASE_EXPIRED');
  });

  it('resource-level quarantine refuses leased resources unless forced', async () => {
    const { lease } = await engine.service.acquire({
      pool: 'buyers',
      owner: OWNER,
      waitTimeoutMs: 0,
    });
    const err = await expectError<TestLeaseError>(() =>
      engine.service.quarantineResource('buyer-01', { reason: 'ops' }, 'cli:ops'),
    );
    expect(err.code).toBe('RESOURCE_LEASED');
    expect(err.details).toMatchObject({ leaseId: lease.leaseId, owner: OWNER });
    const forced = engine.service.quarantineResource(
      'buyer-01',
      { reason: 'ops', force: true },
      'cli:ops',
    );
    expect(forced.resource.state).toBe('QUARANTINED');
    expect(engine.service.getLease(lease.leaseId)).toMatchObject({
      state: 'RELEASED',
      endReason: 'FORCE_RELEASED',
    });
    // idempotent
    expect(
      engine.service.quarantineResource('buyer-01', { reason: 'again' }, 'cli:ops').resource
        .quarantine?.reason,
    ).toBe('ops');
    expect(engine.store.checkIntegrity()).toEqual([]);
  });

  it('idempotent acquisition returns the same lease for the same clientRequestId', async () => {
    const req = {
      pool: 'buyers',
      owner: OWNER,
      tags: { region: 'nl' },
      clientRequestId: 'gha-483-chromium-worker-1',
      waitTimeoutMs: 0,
    };
    const a = await engine.service.acquire(req);
    const b = await engine.service.acquire(req);
    expect(b.reused).toBe(true);
    expect(b.lease.leaseId).toBe(a.lease.leaseId);
    expect(engine.service.getPool('buyers').counts.leased).toBe(1);
    expect(engine.service.listLeaseEvents(a.lease.leaseId).map((e) => e.type)).toEqual([
      'LEASE_ACQUIRED',
      'LEASE_REUSED',
    ]);

    // Different request under the same key is a conflict, not a silent second lease.
    const conflict = await expectError<TestLeaseError>(
      engine.service.acquire({ ...req, tags: { region: 'be' } }),
    );
    expect(conflict.code).toBe('IDEMPOTENCY_CONFLICT');
    const otherOwner = await expectError<TestLeaseError>(
      engine.service.acquire({ ...req, owner: OTHER }),
    );
    expect(otherOwner.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(engine.service.getPool('buyers').counts.leased).toBe(1);

    // After release, the key is free again and yields a fresh lease.
    engine.service.release(a.lease.leaseId, { owner: OWNER });
    const c = await engine.service.acquire(req);
    expect(c.reused).toBe(false);
    expect(c.lease.leaseId).not.toBe(a.lease.leaseId);
  });

  it('rejects TTLs above the pool maximum instead of silently clamping', async () => {
    const err = await expectError<TestLeaseError>(
      engine.service.acquire({ pool: 'buyers', owner: OWNER, ttlMs: 2 * 3_600_000 }),
    );
    expect(err.code).toBe('INVALID_REQUEST');
    expect(err.message).toMatch(/exceeds the maximum TTL 1h/);
  });

  it('validates requests with stable INVALID_REQUEST errors', async () => {
    const err = await expectError<TestLeaseError>(
      engine.service.acquire({ pool: '', owner: 'has space' } as never),
    );
    expect(err.code).toBe('INVALID_REQUEST');
    expect(err.details?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'pool' }),
        expect.objectContaining({ path: 'owner' }),
      ]),
    );
    const unknown = await expectError<TestLeaseError>(
      engine.service.acquire({ pool: 'buyers', owner: OWNER, bogus: 1 } as never),
    );
    expect(unknown.code).toBe('INVALID_REQUEST');
  });

  it('secret references are only handed to the active owner and the access is recorded', async () => {
    const { lease } = await engine.service.acquire({
      pool: 'buyers',
      owner: OWNER,
      waitTimeoutMs: 0,
    });
    const refs = engine.service.secretRefsForLease(lease.leaseId, OWNER);
    expect(refs.refs).toEqual({ password: 'env:BUYER_01_PASSWORD' });
    const err = await expectError<TestLeaseError>(() =>
      engine.service.secretRefsForLease(lease.leaseId, OTHER),
    );
    expect(err.code).toBe('LEASE_OWNERSHIP_MISMATCH');
    const resolved = await engine.api.resolveSecrets(lease.leaseId, { owner: OWNER });
    expect(resolved.secrets).toEqual({ password: 'hunter2-buyer-01' });
    // One direct refs lookup above plus one resolution through the API: both are recorded.
    const ev = engine.service
      .listLeaseEvents(lease.leaseId)
      .filter((e) => e.type === 'LEASE_SECRETS_RESOLVED');
    expect(ev).toHaveLength(2);
    expect(ev[0]!.details).toEqual({ secretKeys: ['password'] });
    expect(JSON.stringify(ev)).not.toContain('hunter2');
    engine.service.release(lease.leaseId, { owner: OWNER });
    const gone = await expectError<TestLeaseError>(() =>
      engine.service.secretRefsForLease(lease.leaseId, OWNER),
    );
    expect(gone.code).toBe('LEASE_NOT_ACTIVE');
  });

  it('pool summaries count states and waiters', async () => {
    await engine.service.acquire({ pool: 'buyers', owner: OWNER, waitTimeoutMs: 0 });
    const summaries = engine.service.listPools();
    expect(summaries.map((s) => s.name)).toEqual(['admins', 'buyers']);
    expect(summaries[1]!.counts).toEqual({
      available: 2,
      leased: 1,
      quarantined: 0,
      disabled: 0,
      total: 3,
    });
    expect(summaries[1]!.description).toBe('Premium buyer accounts');
  });
});

describe('waiting and fairness', () => {
  let engine: TestLeaseEngine;
  beforeEach(async () => {
    engine = await makeEngine({});
  });
  afterEach(() => engine.close());

  it('waiters are served FIFO as resources are released', async () => {
    const held = await Promise.all(
      [1, 2, 3].map((i) =>
        engine.service.acquire({ pool: 'buyers', owner: `w${i}`, waitTimeoutMs: 0 }),
      ),
    );
    const order: string[] = [];
    const waiters = ['w4', 'w5', 'w6'].map((owner) =>
      engine.service.acquire({ pool: 'buyers', owner, waitTimeoutMs: 5000 }).then((r) => {
        order.push(owner);
        return r;
      }),
    );
    expect(engine.service.getPool('buyers').waiting).toBe(3);
    expect(engine.service.getPool('buyers').waiters.map((w) => w.owner)).toEqual([
      'w4',
      'w5',
      'w6',
    ]);
    engine.service.release(held[2]!.lease.leaseId, { owner: 'w3' });
    engine.service.release(held[0]!.lease.leaseId, { owner: 'w1' });
    engine.service.release(held[1]!.lease.leaseId, { owner: 'w2' });
    const results = await Promise.all(waiters);
    expect(order).toEqual(['w4', 'w5', 'w6']);
    expect(results[0]!.resource.id).toBe('buyer-03');
    expect(results[0]!.waitedMs).toBeGreaterThanOrEqual(0);
    expect(engine.service.getPool('buyers').waiting).toBe(0);
    expect(engine.store.checkIntegrity()).toEqual([]);
  });

  it('a later waiter with different tags is served when the earlier waiter cannot use the freed resource', async () => {
    const be = await engine.service.acquire({
      pool: 'buyers',
      owner: 'holder-be',
      tags: { region: 'be' },
      waitTimeoutMs: 0,
    });
    const nl1 = await engine.service.acquire({
      pool: 'buyers',
      owner: 'holder-nl1',
      tags: { region: 'nl' },
      waitTimeoutMs: 0,
    });
    const nl2 = await engine.service.acquire({
      pool: 'buyers',
      owner: 'holder-nl2',
      tags: { region: 'nl' },
      waitTimeoutMs: 0,
    });
    const wantsNl = engine.service.acquire({
      pool: 'buyers',
      owner: 'wants-nl',
      tags: { region: 'nl' },
      waitTimeoutMs: 5000,
    });
    const wantsBe = engine.service.acquire({
      pool: 'buyers',
      owner: 'wants-be',
      tags: { region: 'be' },
      waitTimeoutMs: 5000,
    });
    engine.service.release(be.lease.leaseId, { owner: 'holder-be' });
    const gotBe = await wantsBe;
    expect(gotBe.resource.id).toBe('buyer-03');
    expect(engine.service.getPool('buyers').waiters.map((w) => w.owner)).toEqual(['wants-nl']);
    engine.service.release(nl1.lease.leaseId, { owner: 'holder-nl1' });
    expect((await wantsNl).resource.metadata.region).toBe('nl');
    engine.service.release(nl2.lease.leaseId, { owner: 'holder-nl2' });
  });

  it('times out with ACQUIRE_TIMEOUT, a diagnostic and an event', async () => {
    await Promise.all(
      [1, 2, 3].map((i) =>
        engine.service.acquire({ pool: 'buyers', owner: `w${i}`, waitTimeoutMs: 0 }),
      ),
    );
    const err = await expectError<TestLeaseError>(
      engine.service.acquire({ pool: 'buyers', owner: 'late', waitTimeoutMs: 150 }),
    );
    expect(err.code).toBe('ACQUIRE_TIMEOUT');
    expect(err.message).toMatch(/No matching resource became available within 150ms/);
    expect(err.message).toMatch(/buyer-01\s+LEASED\s+owner=w1/);
    expect(err.details?.waitedMs).toBeGreaterThanOrEqual(140);
    const recent = engine.service.listRecentEvents(5);
    expect(recent.some((e) => e.type === 'ACQUIRE_TIMEOUT' && e.owner === 'late')).toBe(true);
    expect(engine.service.getPool('buyers').waiting).toBe(0);
  });

  it('aborting removes the waiter so it can never be assigned a resource', async () => {
    const holders = await Promise.all(
      [1, 2, 3].map((i) =>
        engine.service.acquire({ pool: 'buyers', owner: `w${i}`, waitTimeoutMs: 0 }),
      ),
    );
    const ac = new AbortController();
    const waiting = engine.service.acquire(
      { pool: 'buyers', owner: 'gone', waitTimeoutMs: 5000 },
      { signal: ac.signal },
    );
    expect(engine.service.getPool('buyers').waiting).toBe(1);
    ac.abort();
    const err = await expectError<TestLeaseError>(waiting);
    expect(err.code).toBe('ACQUIRE_ABORTED');
    expect(engine.service.getPool('buyers').waiting).toBe(0);
    engine.service.release(holders[0]!.lease.leaseId, { owner: 'w1' });
    expect(engine.service.getResource('buyer-01').state).toBe('AVAILABLE');
  });

  it('respects the server-side maximum wait', async () => {
    engine.close();
    engine = await makeEngine({ maxWaitMs: 100 });
    await Promise.all(
      [1, 2, 3].map((i) =>
        engine.service.acquire({ pool: 'buyers', owner: `w${i}`, waitTimeoutMs: 0 }),
      ),
    );
    const started = Date.now();
    const err = await expectError<TestLeaseError>(
      engine.service.acquire({ pool: 'buyers', owner: 'late', waitTimeoutMs: 60_000 }),
    );
    expect(err.code).toBe('ACQUIRE_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('stop() fails waiters with SERVER_SHUTTING_DOWN but keeps active leases', async () => {
    const holders = await Promise.all(
      [1, 2, 3].map((i) =>
        engine.service.acquire({ pool: 'buyers', owner: `w${i}`, waitTimeoutMs: 0 }),
      ),
    );
    const waiting = engine.service.acquire({ pool: 'buyers', owner: 'w4', waitTimeoutMs: 5000 });
    engine.service.stop();
    const err = await expectError<TestLeaseError>(waiting);
    expect(err.code).toBe('SERVER_SHUTTING_DOWN');
    expect(engine.store.getLease(holders[0]!.lease.leaseId)!.state).toBe('ACTIVE');
    const late = await expectError<TestLeaseError>(
      engine.service.acquire({ pool: 'buyers', owner: 'w5' }),
    );
    expect(late.code).toBe('SERVER_SHUTTING_DOWN');
  });

  it('a restored resource wakes waiters', async () => {
    const { lease } = await engine.service.acquire({
      pool: 'admins',
      owner: 'a1',
      waitTimeoutMs: 0,
    });
    engine.service.quarantine(lease.leaseId, { owner: 'a1', reason: 'locked' });
    const waiting = engine.service.acquire({ pool: 'admins', owner: 'a2', waitTimeoutMs: 5000 });
    expect(engine.service.getPool('admins').waiting).toBe(1);
    engine.service.restoreResource('admin-01');
    expect((await waiting).resource.id).toBe('admin-01');
  });

  it('an expiring lease wakes waiters (real clock, short TTL)', async () => {
    const short = await makeEngine({
      configInput: { pools: { p: { defaultTtl: '1s', resources: [{ id: 'only' }] } } },
    });
    try {
      // TTL minimum is 1s; use a 1s lease and a waiter with a 5s budget.
      await short.service.acquire({ pool: 'p', owner: 'dead', waitTimeoutMs: 0 });
      const started = Date.now();
      const res = await short.service.acquire({ pool: 'p', owner: 'next', waitTimeoutMs: 5000 });
      expect(res.resource.id).toBe('only');
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      short.close();
    }
  });
});

describe('configuration sync', () => {
  it('disables removed resources (deferred while leased), re-enables and updates metadata', async () => {
    const clock = new ManualClock();
    const input = baseConfigInput() as {
      pools: Record<
        string,
        { resources: { id: string; metadata?: Record<string, unknown>; enabled?: boolean }[] }
      >;
    };
    const first = await makeEngine({ clock, configInput: input, dbPath: ':memory:' });
    // Use a file DB so we can restart with different config.
    first.close();
    const { tempDir } = await import('../helpers.js');
    const { dir, cleanup } = tempDir();
    try {
      const dbPath = `${dir}/tl.db`;
      const e1 = await makeEngine({ clock, configInput: input, dbPath });
      const { lease } = await e1.service.acquire({
        pool: 'buyers',
        owner: 'w1',
        tags: { region: 'be' },
        waitTimeoutMs: 0,
      });
      e1.close();

      // Remove buyer-03 (leased) and buyer-02, change buyer-01 metadata.
      input.pools.buyers!.resources = [
        {
          id: 'buyer-01',
          metadata: { email: 'buyer01@example.test', region: 'nl', paymentMethod: 'card' },
        },
      ];
      const e2 = await makeEngine({ clock, configInput: input, dbPath });
      expect(e2.sync.disabled.sort()).toEqual(['buyer-02', 'buyer-03']);
      expect(e2.sync.updated).toEqual(['buyer-01']);
      expect(e2.service.getResource('buyer-02').state).toBe('DISABLED');
      expect(e2.service.getResource('buyer-03').state).toBe('LEASED'); // lease survives the config change
      expect(e2.service.getResource('buyer-03').enabled).toBe(false);
      expect(e2.service.getLease(lease.leaseId).state).toBe('ACTIVE');
      e2.service.release(lease.leaseId, { owner: 'w1' });
      expect(e2.service.getResource('buyer-03').state).toBe('DISABLED');
      const pool = e2.service.getPool('buyers');
      expect(pool.counts).toEqual({
        available: 1,
        leased: 0,
        quarantined: 0,
        disabled: 2,
        total: 3,
      });
      // Disabled matches do not cause waiting.
      const err = await expectError<TestLeaseError>(
        e2.service.acquire({ pool: 'buyers', owner: 'w2', tags: { region: 'be' } }),
      );
      expect(err.code).toBe('NO_MATCHING_RESOURCE');
      expect(err.message).toMatch(/buyer-03 match but are disabled/);
      e2.close();

      // Bring buyer-03 back.
      input.pools.buyers!.resources.push({ id: 'buyer-03', metadata: { region: 'be' } });
      const e3 = await makeEngine({ clock, configInput: input, dbPath });
      expect(e3.sync.enabled).toEqual(['buyer-03']);
      expect(e3.service.getResource('buyer-03').state).toBe('AVAILABLE');
      const types = e3.service.listResourceEvents('buyer-03').map((e) => e.type);
      // deferred disable (leased) -> release -> effective disable -> metadata change on re-add -> re-enable
      expect(types).toEqual([
        'RESOURCE_REGISTERED',
        'LEASE_ACQUIRED',
        'RESOURCE_DISABLED',
        'LEASE_RELEASED',
        'RESOURCE_DISABLED',
        'RESOURCE_UPDATED',
        'RESOURCE_ENABLED',
      ]);
      e3.close();
    } finally {
      cleanup();
    }
  });

  it('keeps quarantine across restarts and config re-sync', async () => {
    const { dir, cleanup } = (await import('../helpers.js')).tempDir();
    try {
      const dbPath = `${dir}/tl.db`;
      const e1 = await makeEngine({ dbPath });
      const { lease } = await e1.service.acquire({ pool: 'admins', owner: 'a', waitTimeoutMs: 0 });
      e1.service.quarantine(lease.leaseId, { owner: 'a', reason: 'locked out' });
      e1.close();
      const e2 = await makeEngine({ dbPath });
      expect(e2.service.getResource('admin-01')).toMatchObject({
        state: 'QUARANTINED',
        quarantine: { reason: 'locked out' },
      });
      e2.close();
    } finally {
      cleanup();
    }
  });

  it('fails startup when secret references are missing, listing all of them', async () => {
    const err = await expectError<Error>(makeEngine({ secrets: { BUYER_01_PASSWORD: 'x' } }));
    expect(err.message).toMatch(/3 secret reference\(s\) cannot be resolved/);
    expect(err.message).toMatch(/BUYER_02_PASSWORD/);
    expect(err.message).toMatch(/ADMIN_PASSWORD/);
  });
});
