import type {
  AcquireResponse,
  LeaseEvent,
  LeaseView,
  PoolDetail,
  PoolSummary,
  ResourceView,
} from '@testlease/protocol';

/**
 * Everything the MCP server returns goes through these projections. They are allow-lists:
 * only the listed fields exist in MCP output, so a future field on a domain type cannot
 * accidentally leak. Secret values never reach this package at all (it is typed against
 * `TestLeaseApi`, which has no secret-resolution method); the projections additionally drop
 * secret *references* and keep only secret *names*.
 */

export interface McpLease {
  leaseId: string;
  pool: string;
  resourceId: string;
  owner: string;
  state: LeaseView['state'];
  tags: Record<string, string>;
  metadata: Record<string, string | number | boolean>;
  /** Names of secrets a test runner could resolve with a `secrets:resolve` token. Never values. */
  availableSecretKeys: string[];
  createdAt: string;
  expiresAt: string;
  lastHeartbeatAt: string;
  ttlSeconds: number;
  endedAt?: string;
  endReason?: LeaseView['endReason'];
  purpose?: string;
}

export interface McpAcquireResult extends McpLease {
  reused: boolean;
  waitedSeconds: number;
}

export interface McpResource {
  resourceId: string;
  state: ResourceView['state'];
  tags: Record<string, string>;
  metadata: Record<string, string | number | boolean>;
  availableSecretKeys: string[];
  leasedBy?: string;
  leaseExpiresAt?: string;
  quarantineReason?: string;
}

export interface McpPoolSummary {
  pool: string;
  description?: string;
  available: number;
  leased: number;
  quarantined: number;
  disabled: number;
  total: number;
  waiting: number;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
}

export interface McpPoolStatus extends McpPoolSummary {
  resources: McpResource[];
  waiters: {
    owner: string;
    tags: Record<string, string>;
    waitingSeconds: number;
    purpose?: string;
  }[];
}

const iso = (ms: number) => new Date(ms).toISOString();

export function toMcpLease(lease: LeaseView): McpLease {
  return {
    leaseId: lease.leaseId,
    pool: lease.pool,
    resourceId: lease.resourceId,
    owner: lease.owner,
    state: lease.state,
    tags: { ...lease.resource.tags },
    metadata: { ...lease.resource.metadata },
    availableSecretKeys: [...lease.resource.secretKeys],
    createdAt: iso(lease.createdAt),
    expiresAt: iso(lease.expiresAt),
    lastHeartbeatAt: iso(lease.lastHeartbeatAt),
    ttlSeconds: Math.round(lease.ttlMs / 1000),
    ...(lease.endedAt ? { endedAt: iso(lease.endedAt) } : {}),
    ...(lease.endReason ? { endReason: lease.endReason } : {}),
    ...(lease.purpose ? { purpose: lease.purpose } : {}),
  };
}

export function toMcpAcquireResult(res: AcquireResponse): McpAcquireResult {
  return {
    ...toMcpLease(res.lease),
    reused: res.reused,
    waitedSeconds: Math.round(res.waitedMs / 1000),
  };
}

export function toMcpResource(r: ResourceView): McpResource {
  return {
    resourceId: r.id,
    state: r.state,
    tags: { ...r.tags },
    metadata: { ...r.metadata },
    availableSecretKeys: [...r.secretKeys],
    ...(r.activeLease
      ? { leasedBy: r.activeLease.owner, leaseExpiresAt: iso(r.activeLease.expiresAt) }
      : {}),
    ...(r.quarantine ? { quarantineReason: r.quarantine.reason } : {}),
  };
}

export function toMcpPoolSummary(p: PoolSummary): McpPoolSummary {
  return {
    pool: p.name,
    ...(p.description ? { description: p.description } : {}),
    available: p.counts.available,
    leased: p.counts.leased,
    quarantined: p.counts.quarantined,
    disabled: p.counts.disabled,
    total: p.counts.total,
    waiting: p.waiting,
    defaultTtlSeconds: Math.round(p.defaultTtlMs / 1000),
    maxTtlSeconds: Math.round(p.maxTtlMs / 1000),
  };
}

export function toMcpPoolStatus(p: PoolDetail): McpPoolStatus {
  return {
    ...toMcpPoolSummary(p),
    resources: p.resources.map(toMcpResource),
    waiters: p.waiters.map((w) => ({
      owner: w.owner,
      tags: { ...w.tags },
      waitingSeconds: Math.round(w.waitingForMs / 1000),
      ...(w.purpose ? { purpose: w.purpose } : {}),
    })),
  };
}

export interface McpPercentiles {
  p50: number;
  p95: number;
  max: number;
}

/** Pool-level causes of flaky tests over a time window, as returned by `testlease_diagnose`. */
export interface McpPoolDiagnosis {
  pool: string;
  waiting: {
    acquired: number;
    waited: number;
    waitedMs: McpPercentiles | null;
    currentWaiters: number;
  };
  /** Immediate rejections: the pool was full and the caller did not wait. */
  poolExhausted: { count: number };
  /** Callers that waited and gave up when their wait timeout elapsed. */
  acquireTimeouts: { count: number; waitedMs: McpPercentiles | null };
  expiries: {
    count: number;
    noHeartbeatEver: number;
    heartbeatStopped: number;
    maxOverdueMs: number | null;
    topResources: { resourceId: string; count: number }[];
    topOwners: { owner: string; count: number }[];
  };
  quarantine: {
    quarantined: number;
    restored: number;
    reasons: { reason: string; count: number }[];
    /** Resources quarantined as of now, not limited to the window. */
    current: { resourceId: string; reason: string }[];
  };
  contention: {
    attempts: number;
    waitedOrRejected: number;
    /** waitedOrRejected / attempts; null when there were no attempts (no data). */
    ratio: number | null;
    leasesPerResource: { resourceId: string; count: number }[];
  };
  meta: {
    windowStart: string;
    windowMinutes: number;
    /** Events fetched, before filtering by window or type. */
    eventsScanned: number;
    possiblyTruncated: boolean;
    abortedAcquiresTracked: false;
    notes: string[];
  };
}

export interface McpDiagnosisWindow {
  /** Inclusive lower bound on `at` (epoch ms), the `sinceMs` passed to `listPoolEvents`. */
  startMs: number;
  /** The `limit` passed to `listPoolEvents`. */
  limit: number;
  windowMinutes: number;
}

const TOP_N = 5;

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Nearest-rank percentiles; null for an empty sample. */
function percentiles(values: number[]): McpPercentiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (pct: number) => sorted[Math.max(0, Math.ceil((pct * sorted.length) / 100) - 1)]!;
  return { p50: rank(50), p95: rank(95), max: sorted[sorted.length - 1]! };
}

function bump(counts: Map<string, number>, key: string | undefined): void {
  if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Count descending, then key ascending. */
function ranked(counts: Map<string, number>): [string, number][] {
  return [...counts].sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0]));
}

/**
 * Summarises one pool's event history (any order) plus its live detail into the allow-listed
 * `testlease_diagnose` output. Events before `window.startMs` and unknown event types are
 * ignored; only counts, durations, resource ids, owners and quarantine reasons leave here.
 */
export function toMcpPoolDiagnosis(
  events: LeaseEvent[],
  pool: PoolDetail,
  window: McpDiagnosisWindow,
): McpPoolDiagnosis {
  let acquired = 0;
  const waits: number[] = [];
  let exhausted = 0;
  const timeoutWaits: number[] = [];
  let expiries = 0;
  let noHeartbeatEver = 0;
  let maxOverdueMs: number | null = null;
  const expiredResources = new Map<string, number>();
  const expiredOwners = new Map<string, number>();
  let quarantined = 0;
  let restored = 0;
  const reasons = new Map<string, number>();
  const leasesPerResource = new Map<string, number>(pool.resources.map((r) => [r.id, 0]));

  for (const e of events) {
    if (e.at < window.startMs) continue;
    const d = e.details ?? {};
    switch (e.type) {
      case 'LEASE_ACQUIRED': {
        acquired++;
        const waited = num(d.waitedMs) ?? 0;
        if (waited > 0) waits.push(waited);
        bump(leasesPerResource, e.resourceId);
        break;
      }
      case 'ACQUIRE_TIMEOUT':
        if (d.immediate === true) exhausted++;
        else timeoutWaits.push(num(d.waitedMs) ?? 0);
        break;
      case 'LEASE_EXPIRED': {
        expiries++;
        const lastHeartbeatAt = num(d.lastHeartbeatAt);
        const heldMs = num(d.heldMs);
        if (
          lastHeartbeatAt !== undefined &&
          heldMs !== undefined &&
          lastHeartbeatAt === e.at - heldMs
        )
          noHeartbeatEver++;
        const overdue = num(d.overdueMs);
        if (overdue !== undefined) maxOverdueMs = Math.max(maxOverdueMs ?? overdue, overdue);
        bump(expiredResources, e.resourceId);
        bump(expiredOwners, e.owner);
        break;
      }
      case 'RESOURCE_QUARANTINED':
        quarantined++;
        if (typeof d.reason === 'string') bump(reasons, d.reason);
        break;
      case 'RESOURCE_RESTORED':
        restored++;
        break;
      default:
        break;
    }
  }

  const attempts = acquired + exhausted + timeoutWaits.length;
  const waitedOrRejected = waits.length + exhausted + timeoutWaits.length;
  const possiblyTruncated = events.length === window.limit;
  const notes = [
    'Expiries are recorded by the server reaper, so the newest ones can lag by up to one reaper tick (at most 30s).',
    'Acquires aborted by the caller before their wait timeout write no event and are not counted.',
  ];
  if (possiblyTruncated)
    notes.push(
      `The history reached the ${window.limit}-event fetch limit; older events in the window may be missing. Narrow windowMinutes for a complete picture.`,
    );

  return {
    pool: pool.name,
    waiting: {
      acquired,
      waited: waits.length,
      waitedMs: percentiles(waits),
      currentWaiters: pool.waiters.length,
    },
    poolExhausted: { count: exhausted },
    acquireTimeouts: { count: timeoutWaits.length, waitedMs: percentiles(timeoutWaits) },
    expiries: {
      count: expiries,
      noHeartbeatEver,
      heartbeatStopped: expiries - noHeartbeatEver,
      maxOverdueMs,
      topResources: ranked(expiredResources)
        .slice(0, TOP_N)
        .map(([resourceId, count]) => ({ resourceId, count })),
      topOwners: ranked(expiredOwners)
        .slice(0, TOP_N)
        .map(([owner, count]) => ({ owner, count })),
    },
    quarantine: {
      quarantined,
      restored,
      reasons: ranked(reasons).map(([reason, count]) => ({ reason, count })),
      current: pool.resources
        .filter((r) => r.state === 'QUARANTINED')
        .map((r) => ({ resourceId: r.id, reason: r.quarantine?.reason ?? '' }))
        .sort((a, b) => compareIds(a.resourceId, b.resourceId)),
    },
    contention: {
      attempts,
      waitedOrRejected,
      ratio: attempts === 0 ? null : waitedOrRejected / attempts,
      leasesPerResource: ranked(leasesPerResource).map(([resourceId, count]) => ({
        resourceId,
        count,
      })),
    },
    meta: {
      windowStart: iso(window.startMs),
      windowMinutes: window.windowMinutes,
      eventsScanned: events.length,
      possiblyTruncated,
      abortedAcquiresTracked: false,
      notes,
    },
  };
}
