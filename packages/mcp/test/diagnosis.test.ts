/**
 * `toMcpPoolDiagnosis` is the pure core of `testlease_diagnose`: it turns one pool's event
 * history (as returned by `listPoolEvents`, newest first) plus the live pool detail into an
 * allow-listed summary of why tests on that pool are flaky.
 */
import { describe, expect, it } from 'vitest';
import type { LeaseEvent, LeaseEventType, PoolDetail, ResourceView } from '@testlease/protocol';
import * as sanitize from '../src/sanitize.js';
import type { DiagnoseFn, DiagnosisWindow } from './diagnosis-contract.js';
import { assertNoSecrets, SECRETS } from './helpers.js';

function diagnose(events: LeaseEvent[], pool: PoolDetail, window: DiagnosisWindow) {
  const fn = (sanitize as typeof sanitize & { toMcpPoolDiagnosis?: DiagnoseFn }).toMcpPoolDiagnosis;
  expect(fn, 'sanitize.ts must export toMcpPoolDiagnosis').toBeTypeOf('function');
  return fn!(events, pool, window);
}

/** Every key that may appear anywhere in a diagnosis. Anything else is a leak. */
const ALLOWED_KEYS = new Set([
  'pool',
  'waiting',
  'acquired',
  'waited',
  'waitedMs',
  'p50',
  'p95',
  'max',
  'currentWaiters',
  'poolExhausted',
  'count',
  'acquireTimeouts',
  'expiries',
  'noHeartbeatEver',
  'heartbeatStopped',
  'maxOverdueMs',
  'topResources',
  'resourceId',
  'topOwners',
  'owner',
  'quarantine',
  'quarantined',
  'restored',
  'reasons',
  'reason',
  'current',
  'contention',
  'attempts',
  'waitedOrRejected',
  'ratio',
  'leasesPerResource',
  'meta',
  'windowStart',
  'windowMinutes',
  'eventsScanned',
  'possiblyTruncated',
  'abortedAcquiresTracked',
  'notes',
]);

function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) allKeys(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

const T0 = 1_700_000_000_000;
const WINDOW: DiagnosisWindow = { startMs: T0, limit: 1000, windowMinutes: 60 };

let seq = 0;
function ev(
  type: LeaseEventType,
  at: number,
  fields: Omit<LeaseEvent, 'seq' | 'at' | 'type'> = {},
): LeaseEvent {
  return { seq: ++seq, at, type, pool: 'buyers', ...fields };
}

const acquired = (at: number, resourceId: string, waitedMs: number, owner = 'w') =>
  ev('LEASE_ACQUIRED', at, {
    resourceId,
    leaseId: `lease_${seq + 1}`,
    owner,
    details: { ttlMs: 600_000, expiresAt: at + 600_000, waitedMs, principal: 'local' },
  });

const timeout = (at: number, waitedMs: number, immediate?: boolean, owner = 'w') =>
  ev('ACQUIRE_TIMEOUT', at, {
    owner,
    details: { waitedMs, tags: {}, ...(immediate === undefined ? {} : { immediate }) },
  });

/** A lease created at `createdAt` that expired at `at`; `heartbeatAt` defaults to never. */
const expired = (
  at: number,
  resourceId: string,
  owner: string,
  opts: { createdAt: number; heartbeatAt?: number; overdueMs: number },
) =>
  ev('LEASE_EXPIRED', at, {
    resourceId,
    leaseId: `lease_${seq + 1}`,
    owner,
    details: {
      expiresAt: at - opts.overdueMs,
      lastHeartbeatAt: opts.heartbeatAt ?? opts.createdAt,
      overdueMs: opts.overdueMs,
      heldMs: at - opts.createdAt,
    },
  });

function resource(id: string, extra: Partial<ResourceView> = {}): ResourceView {
  return {
    id,
    pool: 'buyers',
    state: 'AVAILABLE',
    enabledInConfig: true,
    tags: {},
    metadata: {},
    secretKeys: [],
    createdAt: T0 - 86_400_000,
    updatedAt: T0 - 86_400_000,
    ...extra,
  };
}

function poolDetail(resources: ResourceView[], waiters: PoolDetail['waiters'] = []): PoolDetail {
  const count = (s: ResourceView['state']) => resources.filter((r) => r.state === s).length;
  return {
    name: 'buyers',
    defaultTtlMs: 600_000,
    maxTtlMs: 3_600_000,
    counts: {
      available: count('AVAILABLE'),
      leased: count('LEASED'),
      quarantined: count('QUARANTINED'),
      disabled: count('DISABLED'),
      total: resources.length,
    },
    waiting: waiters.length,
    resources,
    waiters,
  };
}

const twoFree = () => poolDetail([resource('buyer-01'), resource('buyer-02')]);
const newestFirst = (events: LeaseEvent[]) =>
  [...events].sort((a, b) => b.at - a.at || b.seq - a.seq);

describe('toMcpPoolDiagnosis', () => {
  it('summarises an empty history as zeros, nulls and empty lists', () => {
    const d = diagnose([], twoFree(), WINDOW);
    expect(d).toEqual({
      pool: 'buyers',
      waiting: { acquired: 0, waited: 0, waitedMs: null, currentWaiters: 0 },
      poolExhausted: { count: 0 },
      acquireTimeouts: { count: 0, waitedMs: null },
      expiries: {
        count: 0,
        noHeartbeatEver: 0,
        heartbeatStopped: 0,
        maxOverdueMs: null,
        topResources: [],
        topOwners: [],
      },
      quarantine: { quarantined: 0, restored: 0, reasons: [], current: [] },
      contention: {
        attempts: 0,
        waitedOrRejected: 0,
        ratio: null, // no attempts: no data, which is not the same as no contention
        leasesPerResource: [
          { resourceId: 'buyer-01', count: 0 },
          { resourceId: 'buyer-02', count: 0 },
        ],
      },
      meta: {
        windowStart: new Date(T0).toISOString(),
        windowMinutes: 60,
        eventsScanned: 0,
        possiblyTruncated: false,
        abortedAcquiresTracked: false,
        notes: expect.arrayContaining([expect.stringMatching(/reaper/i)]) as string[],
      },
    });
  });

  it('counts waited vs immediate acquisitions and takes nearest-rank percentiles of the waits', () => {
    const events: LeaseEvent[] = [];
    // 20 waited acquisitions of 10..200 ms, recorded out of order, plus 3 immediate ones.
    for (let i = 20; i >= 1; i--) events.push(acquired(T0 + i, 'buyer-01', i * 10));
    for (let i = 0; i < 3; i++) events.push(acquired(T0 + 100 + i, 'buyer-02', 0));
    // A reused lease is not a new acquisition, whatever its waitedMs says.
    events.push(
      ev('LEASE_REUSED', T0 + 200, {
        resourceId: 'buyer-01',
        owner: 'w',
        details: { clientRequestId: 'retry-1', waitedMs: 5_000 },
      }),
    );
    const waiters = [
      { owner: 'a', tags: {}, waitingForMs: 1_000 },
      { owner: 'b', tags: {}, waitingForMs: 2_000 },
    ];
    const d = diagnose(
      events,
      poolDetail([resource('buyer-01'), resource('buyer-02')], waiters),
      WINDOW,
    );
    expect(d.waiting).toEqual({
      acquired: 23,
      waited: 20,
      waitedMs: { p50: 100, p95: 190, max: 200 },
      currentWaiters: 2,
    });
  });

  it('splits ACQUIRE_TIMEOUT into poolExhausted (immediate) and acquireTimeouts (waited)', () => {
    const events = [
      timeout(T0 + 1, 0, true),
      timeout(T0 + 2, 0, true),
      // Waited timeouts omit `immediate`; an explicit false is still a waited timeout.
      timeout(T0 + 3, 300),
      timeout(T0 + 4, 700),
      timeout(T0 + 5, 500),
      timeout(T0 + 6, 400, false),
    ];
    const d = diagnose(newestFirst(events), twoFree(), WINDOW);
    expect(d.poolExhausted).toEqual({ count: 2 });
    expect(d.acquireTimeouts).toEqual({ count: 4, waitedMs: { p50: 400, p95: 700, max: 700 } });
    // Timeouts are not acquisitions.
    expect(d.waiting).toMatchObject({ acquired: 0, waited: 0, waitedMs: null });
  });

  it('classifies expiries as "no heartbeat ever" vs "heartbeat stopped" and ranks resources/owners', () => {
    const events = [
      // lastHeartbeatAt === createdAt (= at - heldMs): never renewed.
      expired(T0 + 10_000, 'buyer-01', 'worker-a', { createdAt: T0 + 5_000, overdueMs: 120 }),
      expired(T0 + 20_000, 'buyer-01', 'worker-b', {
        createdAt: T0 + 12_000,
        heartbeatAt: T0 + 15_000,
        overdueMs: 900,
      }),
      expired(T0 + 30_000, 'buyer-02', 'worker-a', { createdAt: T0 + 27_000, overdueMs: 40 }),
      expired(T0 + 40_000, 'buyer-03', 'worker-c', {
        createdAt: T0 + 31_000,
        heartbeatAt: T0 + 35_000,
        overdueMs: 300,
      }),
    ];
    const d = diagnose(newestFirst(events), twoFree(), WINDOW);
    expect(d.expiries).toEqual({
      count: 4,
      noHeartbeatEver: 2,
      heartbeatStopped: 2,
      maxOverdueMs: 900,
      topResources: [
        { resourceId: 'buyer-01', count: 2 },
        { resourceId: 'buyer-02', count: 1 },
        { resourceId: 'buyer-03', count: 1 },
      ],
      topOwners: [
        { owner: 'worker-a', count: 2 },
        { owner: 'worker-b', count: 1 },
        { owner: 'worker-c', count: 1 },
      ],
    });
  });

  it('keeps only the top 5 expiring resources and owners, ties broken by id ascending', () => {
    const ids = ['r-g', 'r-f', 'r-e', 'r-d', 'r-c', 'r-b', 'r-a'];
    const events = ids.map((id, i) =>
      expired(T0 + 1_000 * (i + 1), id, `owner-${id}`, { createdAt: T0, overdueMs: 1 }),
    );
    const d = diagnose(newestFirst(events), twoFree(), WINDOW);
    expect(d.expiries.count).toBe(7);
    expect(d.expiries.topResources.map((r) => r.resourceId)).toEqual([
      'r-a',
      'r-b',
      'r-c',
      'r-d',
      'r-e',
    ]);
    expect(d.expiries.topOwners.map((o) => o.owner)).toEqual([
      'owner-r-a',
      'owner-r-b',
      'owner-r-c',
      'owner-r-d',
      'owner-r-e',
    ]);
  });

  it('counts quarantines and restores; lists only resources that are quarantined now', () => {
    const quarantined = (at: number, resourceId: string, reason: string) =>
      ev('RESOURCE_QUARANTINED', at, { resourceId, owner: 'w', details: { reason } });
    const events = [
      quarantined(T0 + 1, 'buyer-01', 'account locked'),
      quarantined(T0 + 2, 'buyer-02', 'captcha wall'),
      quarantined(T0 + 3, 'buyer-03', 'account locked'),
      ev('RESOURCE_RESTORED', T0 + 4, {
        resourceId: 'buyer-02',
        details: { previousReason: 'captcha wall', quarantinedForMs: 2, state: 'AVAILABLE' },
      }),
    ];
    const now = poolDetail([
      resource('buyer-01', {
        state: 'QUARANTINED',
        quarantine: { reason: 'account locked', at: T0 + 1, by: 'w' },
      }),
      resource('buyer-02'),
      resource('buyer-03', {
        state: 'QUARANTINED',
        quarantine: { reason: 'account locked', at: T0 + 3, by: 'w' },
      }),
    ]);
    const d = diagnose(newestFirst(events), now, WINDOW);
    expect(d.quarantine).toEqual({
      quarantined: 3,
      restored: 1,
      reasons: [
        { reason: 'account locked', count: 2 },
        { reason: 'captcha wall', count: 1 },
      ],
      current: [
        { resourceId: 'buyer-01', reason: 'account locked' },
        { resourceId: 'buyer-03', reason: 'account locked' },
      ],
    });
  });

  it('computes the contention ratio and sorts leasesPerResource deterministically', () => {
    const events = [
      acquired(T0 + 1, 'buyer-02', 0),
      acquired(T0 + 2, 'buyer-02', 50),
      acquired(T0 + 3, 'buyer-01', 0),
      acquired(T0 + 4, 'buyer-01', 0),
      acquired(T0 + 5, 'buyer-03', 0),
      timeout(T0 + 6, 0, true),
      timeout(T0 + 7, 250),
      ev('LEASE_REUSED', T0 + 8, { resourceId: 'buyer-03', details: { waitedMs: 0 } }),
    ];
    const pool = poolDetail(
      ['buyer-04', 'buyer-03', 'buyer-02', 'buyer-01'].map((id) => resource(id)),
    );
    const d = diagnose(newestFirst(events), pool, WINDOW);
    expect(d.contention.attempts).toBe(7);
    expect(d.contention.waitedOrRejected).toBe(3);
    expect(d.contention.ratio).toBeCloseTo(3 / 7, 10);
    expect(d.contention.leasesPerResource).toEqual([
      { resourceId: 'buyer-01', count: 2 },
      { resourceId: 'buyer-02', count: 2 },
      { resourceId: 'buyer-03', count: 1 },
      { resourceId: 'buyer-04', count: 0 },
    ]);
    // Input order never changes the result.
    expect(diagnose([...events].reverse(), pool, WINDOW)).toEqual(d);
  });

  it('ignores events before the window start (the start itself is inclusive)', () => {
    const before = T0 - 1;
    const events = newestFirst([
      acquired(T0, 'buyer-01', 0),
      acquired(before, 'buyer-02', 400),
      timeout(before, 0, true),
      timeout(before, 900),
      expired(before, 'buyer-02', 'worker-a', { createdAt: before - 5_000, overdueMs: 10 }),
      ev('RESOURCE_QUARANTINED', before, {
        resourceId: 'buyer-02',
        details: { reason: 'old reason' },
      }),
      ev('RESOURCE_RESTORED', before, { resourceId: 'buyer-02', details: {} }),
    ]);
    const d = diagnose(events, twoFree(), WINDOW);
    expect(d.waiting).toEqual({ acquired: 1, waited: 0, waitedMs: null, currentWaiters: 0 });
    expect(d.poolExhausted.count).toBe(0);
    expect(d.acquireTimeouts.count).toBe(0);
    expect(d.expiries.count).toBe(0);
    expect(d.quarantine).toMatchObject({ quarantined: 0, restored: 0, reasons: [] });
    expect(d.contention).toMatchObject({ attempts: 1, waitedOrRejected: 0, ratio: 0 });
    expect(d.contention.leasesPerResource).toEqual([
      { resourceId: 'buyer-01', count: 1 },
      { resourceId: 'buyer-02', count: 0 },
    ]);
  });

  it('only allow-listed fields leave sanitize.ts: no principal, request id, purpose or secrets', () => {
    const leaky = {
      principal: 'principal-marker',
      clientRequestId: 'crid-marker',
      purpose: 'purpose-marker',
      secretKeys: ['secret-key-marker'],
      secretRefs: { password: 'env:BUYER_01_PASSWORD' },
      password: SECRETS.BUYER_01_PASSWORD,
      unknownField: 'unknown-marker',
      nested: { deeper: 'nested-marker', ref: 'env:BUYER_02_PASSWORD' },
    };
    const events = newestFirst([
      ev('LEASE_ACQUIRED', T0 + 1, {
        resourceId: 'buyer-01',
        owner: 'w',
        details: { waitedMs: 30, ttlMs: 1_000, ...leaky },
      }),
      ev('ACQUIRE_TIMEOUT', T0 + 2, {
        owner: 'w',
        details: { waitedMs: 0, immediate: true, ...leaky },
      }),
      ev('ACQUIRE_TIMEOUT', T0 + 3, { owner: 'w', details: { waitedMs: 80, ...leaky } }),
      ev('LEASE_EXPIRED', T0 + 4, {
        resourceId: 'buyer-01',
        owner: 'w',
        details: { lastHeartbeatAt: T0, heldMs: 4, overdueMs: 1, expiresAt: T0 + 3, ...leaky },
      }),
      ev('RESOURCE_QUARANTINED', T0 + 5, {
        resourceId: 'buyer-02',
        owner: 'w',
        details: { reason: 'locked', ...leaky },
      }),
      ev('RESOURCE_RESTORED', T0 + 6, { resourceId: 'buyer-02', details: { ...leaky } }),
      ev('LEASE_SECRETS_RESOLVED', T0 + 7, {
        resourceId: 'buyer-01',
        owner: 'w',
        details: { secretKeys: ['password'], principal: 'principal-marker' },
      }),
      // Unknown event types and unknown top-level fields are dropped, not echoed.
      {
        ...ev('LEASE_RENEWED', T0 + 8, { resourceId: 'buyer-01' }),
        extra: 'extra-marker',
      } as LeaseEvent,
      { ...ev('BRAND_NEW_TYPE' as LeaseEventType, T0 + 9), details: leaky },
    ]);
    const pool = poolDetail(
      [
        resource('buyer-01', {
          state: 'LEASED',
          tags: { region: 'tag-marker' },
          metadata: { email: 'metadata-marker@example.test' },
          secretKeys: ['password'],
          activeLease: {
            leaseId: 'lease_x',
            owner: 'w',
            createdAt: T0,
            expiresAt: T0 + 1_000,
            purpose: 'active-purpose-marker',
          },
        }),
        resource('buyer-02', { secretKeys: ['password'] }),
      ],
      [
        {
          owner: 'waiter',
          tags: { region: 'tag-marker' },
          waitingForMs: 5,
          purpose: 'waiter-purpose-marker',
        },
      ],
    );
    const d = diagnose(events, pool, WINDOW);
    const json = JSON.stringify(d);
    assertNoSecrets(json, 'diagnosis');
    expect(json).not.toMatch(/marker/);
    expect(json).not.toContain(SECRETS.BUYER_01_PASSWORD);
    const unexpected = [...allKeys(d)].filter((k) => !ALLOWED_KEYS.has(k));
    expect(unexpected).toEqual([]);
  });

  it('LEASE_SECRETS_RESOLVED events have no effect on any section', () => {
    const base = [
      acquired(T0 + 1, 'buyer-01', 0),
      acquired(T0 + 2, 'buyer-02', 120),
      timeout(T0 + 3, 0, true),
      expired(T0 + 4, 'buyer-01', 'worker-a', { createdAt: T0 + 1, overdueMs: 5 }),
    ];
    const resolved = [
      ev('LEASE_SECRETS_RESOLVED', T0 + 5, {
        resourceId: 'buyer-01',
        owner: 'worker-a',
        details: { secretKeys: ['password'], principal: 'local' },
      }),
      ev('LEASE_SECRETS_RESOLVED', T0 + 6, {
        resourceId: 'buyer-09',
        owner: 'worker-z',
        details: { secretKeys: ['password'], principal: 'local' },
      }),
    ];
    const without = diagnose(newestFirst(base), twoFree(), WINDOW);
    const withResolved = diagnose(newestFirst([...base, ...resolved]), twoFree(), WINDOW);
    // eventsScanned counts what was fetched; nothing else may move.
    const { meta: m1, ...rest1 } = without;
    const { meta: m2, ...rest2 } = withResolved;
    expect(rest2).toEqual(rest1);
    expect({ ...m2, eventsScanned: 0 }).toEqual({ ...m1, eventsScanned: 0 });
  });

  it('flags possiblyTruncated exactly when events.length === limit', () => {
    const events = newestFirst([
      acquired(T0 + 1, 'buyer-01', 0),
      acquired(T0 + 2, 'buyer-02', 0),
      acquired(T0 - 5, 'buyer-02', 0), // outside the window still counts as fetched
    ]);
    const atLimit = diagnose(events, twoFree(), { ...WINDOW, limit: 3 });
    expect(atLimit.meta).toMatchObject({ eventsScanned: 3, possiblyTruncated: true });
    const belowLimit = diagnose(events, twoFree(), { ...WINDOW, limit: 4 });
    expect(belowLimit.meta).toMatchObject({ eventsScanned: 3, possiblyTruncated: false });
    expect(belowLimit.meta.abortedAcquiresTracked).toBe(false);
  });
});
