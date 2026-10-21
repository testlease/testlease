import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CallOptions,
  EventsResponse,
  TestLeaseApi,
  TestLeaseError,
} from '@testlease/protocol';
import { ManualClock } from '../../src/clock.js';
import type { TestLeaseEngine } from '../../src/testlease.js';
import { expectError, makeEngine, TEST_SECRETS } from '../helpers.js';

// Test-only contract declaration: no shim or implementation for the missing method.
type PoolEventsApi = TestLeaseApi & {
  listPoolEvents(
    pool: string,
    query: { sinceMs?: number; limit?: number },
    opts?: CallOptions,
  ): Promise<EventsResponse>;
};

async function listEvents(
  api: TestLeaseApi,
  pool: string,
  query: { sinceMs?: number; limit?: number } = {},
): Promise<EventsResponse> {
  const response = await (api as PoolEventsApi).listPoolEvents(pool, query);
  for (const secret of Object.values(TEST_SECRETS)) {
    expect(JSON.stringify(response)).not.toContain(secret);
  }
  return response;
}

describe('listPoolEvents (in-process)', () => {
  let engine: TestLeaseEngine;
  let clock: ManualClock;

  beforeEach(async () => {
    clock = new ManualClock();
    engine = await makeEngine({ clock });
  });
  afterEach(() => engine.close());

  async function fillBuyers(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await engine.api.acquire({ pool: 'buyers', owner: `holder-${i}` });
    }
  }

  // Seed history directly to test ordering independently of mutation insertion order.
  function record(owner: string, pool = 'buyers'): void {
    engine.store.insertEvent({
      at: clock.now(),
      type: 'ACQUIRE_TIMEOUT',
      pool,
      owner,
      details: { waitedMs: 0, immediate: true },
    });
  }

  describe('#11 pool filtering', () => {
    it('returns only events of the requested pool when several pools have activity', async () => {
      clock.advance(1);
      const sinceMs = clock.now();
      const buyer = await engine.api.acquire({ pool: 'buyers', owner: 'buyer' });
      await engine.api.acquire({ pool: 'admins', owner: 'admin' });
      await engine.api.release(buyer.lease.leaseId, { owner: 'buyer' });
      const response = await listEvents(engine.api, 'buyers', { sinceMs });
      expect(response.events).toEqual(
        (await engine.api.listLeaseEvents(buyer.lease.leaseId)).events.reverse(),
      );
      expect(response.events.map((event) => event.pool)).toEqual(['buyers', 'buyers']);
    });

    it('includes waited ACQUIRE_TIMEOUT events (immediate !== true)', async () => {
      // The wait queue uses a native timeout. Use the real clock only for this test,
      // await its rejection, and make no assertion about exact elapsed time.
      engine.close();
      engine = await makeEngine();
      await fillBuyers();
      const error = await expectError<TestLeaseError>(
        engine.api.acquire({ pool: 'buyers', owner: 'waited', waitTimeoutMs: 100 }),
      );
      expect(error.code).toBe('ACQUIRE_TIMEOUT');
      const { events } = await listEvents(engine.api, 'buyers');
      const timeouts = events.filter((event) => event.type === 'ACQUIRE_TIMEOUT');
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]).toMatchObject({
        type: 'ACQUIRE_TIMEOUT',
        pool: 'buyers',
        owner: 'waited',
      });
      expect(timeouts[0]!.details?.immediate).not.toBe(true);
      expect(timeouts[0]!.details?.waitedMs).toBeGreaterThanOrEqual(0);
    });

    it('includes resource-less immediate POOL_EXHAUSTED attempts', async () => {
      await fillBuyers();
      const error = await expectError<TestLeaseError>(
        engine.api.acquire({ pool: 'buyers', owner: 'immediate' }),
      );
      expect(error.code).toBe('POOL_EXHAUSTED');
      const { events } = await listEvents(engine.api, 'buyers');
      const timeouts = events.filter((event) => event.type === 'ACQUIRE_TIMEOUT');
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]).toMatchObject({
        pool: 'buyers',
        owner: 'immediate',
        details: { immediate: true, waitedMs: 0 },
      });
      expect(timeouts[0]!.resourceId).toBeUndefined();
      expect(timeouts[0]!.leaseId).toBeUndefined();
    });

    it('includes LEASE_EXPIRED and RESOURCE_QUARANTINED events of the pool', async () => {
      const expired = await engine.api.acquire({ pool: 'buyers', owner: 'expires', ttlMs: 1000 });
      const quarantined = await engine.api.acquire({ pool: 'buyers', owner: 'quarantine' });
      const admin = await engine.api.acquire({ pool: 'admins', owner: 'admin' });
      clock.advance(1000);
      engine.service.expireDue();
      await engine.api.quarantine(quarantined.lease.leaseId, {
        owner: 'quarantine',
        reason: 'locked',
      });
      await engine.api.quarantine(admin.lease.leaseId, { owner: 'admin', reason: 'locked' });
      const { events } = await listEvents(engine.api, 'buyers');
      expect(events.filter((event) => event.type === 'LEASE_EXPIRED')).toEqual([
        expect.objectContaining({
          pool: 'buyers',
          leaseId: expired.lease.leaseId,
          at: clock.now(),
        }),
      ]);
      expect(events.filter((event) => event.type === 'RESOURCE_QUARANTINED')).toEqual([
        expect.objectContaining({ pool: 'buyers', resourceId: quarantined.lease.resourceId }),
      ]);
      expect(events.every((event) => event.pool === 'buyers')).toBe(true);
    });

    it('returns an empty list for a known pool without events', async () => {
      engine.close();
      engine = await makeEngine({ clock, configInput: { pools: { empty: { resources: [] } } } });
      expect(await listEvents(engine.api, 'empty')).toEqual({ events: [] });
    });

    it('fails with POOL_NOT_FOUND for an unknown pool', async () => {
      const error = await expectError<TestLeaseError>(() => listEvents(engine.api, 'missing'));
      expect(error).toMatchObject({ code: 'POOL_NOT_FOUND', status: 404 });
    });
  });

  describe('#12 since / limit / ordering', () => {
    it('orders events by at DESC, then seq DESC even when insertion order differs', async () => {
      clock.advance(30);
      record('newest');
      clock.advance(-20);
      record('oldest');
      clock.advance(10);
      record('tie-first');
      record('tie-second');
      const { events } = await listEvents(engine.api, 'buyers', { sinceMs: clock.now() - 10 });
      expect(events.map((event) => event.owner)).toEqual([
        'newest',
        'tie-second',
        'tie-first',
        'oldest',
      ]);
      expect(events[1]!.at).toBe(events[2]!.at);
      expect(events[1]!.seq).toBeGreaterThan(events[2]!.seq);
    });

    it('excludes events older than sinceMs and includes an event exactly at sinceMs', async () => {
      record('before');
      clock.advance(1);
      const sinceMs = clock.now();
      record('boundary');
      clock.advance(1);
      record('after');
      const { events } = await listEvents(engine.api, 'buyers', { sinceMs });
      expect(events.map((event) => [event.owner, event.at])).toEqual([
        ['after', sinceMs + 1],
        ['boundary', sinceMs],
      ]);
    });

    it('limit returns the newest N events of the window', async () => {
      record('outside');
      clock.advance(1);
      const sinceMs = clock.now();
      record('boundary');
      clock.advance(1);
      record('tie-first');
      record('tie-second');
      expect(
        (await listEvents(engine.api, 'buyers', { sinceMs, limit: 2 })).events.map(
          (event) => event.owner,
        ),
      ).toEqual(['tie-second', 'tie-first']);
    });

    it('defaults limit to 1000 and caps larger values at 5000', async () => {
      clock.advance(1);
      const sinceMs = clock.now();
      engine.store.transaction(() => {
        for (let i = 0; i < 5001; i++) {
          record(`event-${i}`);
          clock.advance(1);
        }
      });
      for (const [limit, count] of [
        [undefined, 1000],
        [5000, 5000],
        [5001, 5000],
      ] as const) {
        const { events } = await listEvents(engine.api, 'buyers', {
          sinceMs,
          ...(limit === undefined ? {} : { limit }),
        });
        expect(events.map((event) => event.owner)).toEqual(
          Array.from({ length: count }, (_, i) => `event-${5000 - i}`),
        );
      }
    });

    it.each([{ limit: -1 }, { limit: 1.5 }, { sinceMs: -1 }, { sinceMs: 1.5 }])(
      'rejects invalid query %j with INVALID_REQUEST',
      async (query) => {
        const error = await expectError<TestLeaseError>(() =>
          listEvents(engine.api, 'buyers', query),
        );
        expect(error).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
      },
    );
  });

  describe('#13 pool allow-list (LocalApi bound to a restricted identity)', () => {
    it('returns FORBIDDEN for a pool outside the identity allow-list', async () => {
      const api = engine.api.as('restricted', { pools: new Set(['buyers']) });
      const error = await expectError<TestLeaseError>(() => listEvents(api, 'admins'));
      expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    });

    it('returns events for a pool inside the allow-list', async () => {
      const api = engine.api.as('restricted', { pools: new Set(['buyers']) });
      clock.advance(1);
      const sinceMs = clock.now();
      const { lease } = await api.acquire({ pool: 'buyers', owner: 'allowed' });
      await engine.api.acquire({ pool: 'admins', owner: 'other' });
      expect((await listEvents(api, 'buyers', { sinceMs })).events).toEqual(
        (await api.listLeaseEvents(lease.leaseId)).events,
      );
    });
  });

  describe('known gap', () => {
    it('documents the known gap: an aborted acquisition writes no event', async () => {
      await fillBuyers();
      const before = engine.service.listRecentEvents(100);
      const controller = new AbortController();
      const waiting = engine.api.acquire(
        { pool: 'buyers', owner: 'aborted', waitTimeoutMs: 5000 },
        { signal: controller.signal },
      );
      expect(engine.service.getPool('buyers').waiting).toBe(1);
      controller.abort();
      expect((await expectError<TestLeaseError>(waiting)).code).toBe('ACQUIRE_ABORTED');
      expect(engine.service.getPool('buyers').waiting).toBe(0);
      const after = engine.service.listRecentEvents(100);
      expect(after).toEqual(before);
      expect(after.some((event) => event.owner === 'aborted')).toBe(false);
      for (const secret of Object.values(TEST_SECRETS)) {
        expect(JSON.stringify(after)).not.toContain(secret);
      }
    });
  });
});
