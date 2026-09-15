import type {
  AcquireResponse,
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
