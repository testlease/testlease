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
    current: { resourceId: string; reason: string }[];
  };
  contention: {
    attempts: number;
    waitedOrRejected: number;
    ratio: number;
    leasesPerResource: { resourceId: string; count: number }[];
  };
  meta: {
    windowStart: string;
    windowMinutes: number;
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
