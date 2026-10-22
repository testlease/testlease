/**
 * Test-only contract declaration for `testlease_diagnose` (no shim or implementation): the shape
 * of `toMcpPoolDiagnosis` in `src/sanitize.ts` and of the tool's structured output.
 */
import type { LeaseEvent, PoolDetail } from '@testlease/protocol';

export interface Percentiles {
  p50: number;
  p95: number;
  max: number;
}

export interface McpPoolDiagnosis {
  pool: string;
  waiting: {
    acquired: number;
    waited: number;
    waitedMs: Percentiles | null;
    currentWaiters: number;
  };
  poolExhausted: { count: number };
  acquireTimeouts: { count: number; waitedMs: Percentiles | null };
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
    /** Resources quarantined as of now (from getPool), not limited to the window. */
    current: { resourceId: string; reason: string }[];
  };
  contention: {
    attempts: number;
    waitedOrRejected: number;
    /** waitedOrRejected / attempts; null when there were no attempts (no data, not "no contention"). */
    ratio: number | null;
    leasesPerResource: { resourceId: string; count: number }[];
  };
  meta: {
    /** ISO of `window.startMs`; the tool computes it from the MCP process's Date.now(), not health(). */
    windowStart: string;
    windowMinutes: number;
    /** Events fetched, before filtering (window, ignored types); possiblyTruncated uses the same count. */
    eventsScanned: number;
    possiblyTruncated: boolean;
    abortedAcquiresTracked: false;
    notes: string[];
  };
}

export interface DiagnosisWindow {
  /** Inclusive lower bound on `at` (epoch ms), the same value passed to listPoolEvents as `sinceMs`. */
  startMs: number;
  /** The `limit` passed to listPoolEvents. */
  limit: number;
  windowMinutes: number;
}

export type DiagnoseFn = (
  events: LeaseEvent[],
  pool: PoolDetail,
  window: DiagnosisWindow,
) => McpPoolDiagnosis;
