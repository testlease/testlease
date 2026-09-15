import type { ResourceState, Tags } from '@testlease/protocol';
import { formatClock, formatDuration } from '../duration.js';

export interface DiagnosticResource {
  id: string;
  state: ResourceState;
  /** Whether this resource would satisfy the requested tags. */
  compatible: boolean;
  owner?: string;
  expiresInMs?: number;
  purpose?: string;
  quarantineReason?: string;
}

/** Structured snapshot attached to POOL_EXHAUSTED / ACQUIRE_TIMEOUT errors. Contains no secrets. */
export interface AcquireDiagnostic {
  pool: string;
  requested: Tags;
  waitedMs: number;
  resources: DiagnosticResource[];
  waiters: number;
  oldestWaiterMs: number | null;
}

/**
 * Renders the human-readable diagnostic, e.g.
 *
 *   No matching resource became available within 60s.
 *
 *   Pool: premium-buyers
 *   Requested:
 *     region=nl
 *
 *   Resources:
 *     buyer-01  LEASED       owner=gha-483/chromium/worker-1  expires in 04:31
 *     buyer-03  QUARANTINED  account locked
 *
 *   Waiters: 2 (oldest 41s)
 */
export function formatAcquireDiagnostic(d: AcquireDiagnostic, headline: string): string {
  const lines: string[] = [headline, '', `Pool: ${d.pool}`];
  const tagEntries = Object.entries(d.requested);
  if (tagEntries.length) {
    lines.push('Requested:');
    for (const [k, v] of tagEntries) lines.push(`  ${k}=${v}`);
  } else {
    lines.push('Requested: (any resource)');
  }
  lines.push('', 'Resources:');
  if (d.resources.length === 0) {
    lines.push('  (pool has no resources)');
  }
  const idWidth = Math.max(0, ...d.resources.map((r) => r.id.length));
  for (const r of d.resources) {
    const parts = [`  ${r.id.padEnd(idWidth)}  ${r.state.padEnd(11)}`];
    if (r.state === 'LEASED') {
      if (r.owner) parts.push(`owner=${r.owner}`);
      if (r.expiresInMs !== undefined) parts.push(`expires in ${formatClock(r.expiresInMs)}`);
      if (r.purpose) parts.push(`(${r.purpose})`);
    } else if (r.state === 'QUARANTINED' && r.quarantineReason) {
      parts.push(r.quarantineReason);
    }
    if (!r.compatible) parts.push('[does not match tags]');
    lines.push(parts.join('  '));
  }
  lines.push('');
  lines.push(
    d.waiters === 0
      ? 'Waiters: none'
      : `Waiters: ${d.waiters}${d.oldestWaiterMs !== null ? ` (oldest ${formatDuration(d.oldestWaiterMs)})` : ''}`,
  );
  return lines.join('\n');
}
