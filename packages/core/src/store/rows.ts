import type {
  LeaseEndReason,
  LeaseState,
  Metadata,
  ResourceState,
  Tags,
} from '@testlease/protocol';

export interface PoolRow {
  name: string;
  description: string | null;
  defaultTtlMs: number;
  maxTtlMs: number;
  present: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ResourceRow {
  id: string;
  pool: string;
  state: ResourceState;
  enabledInConfig: boolean;
  tags: Tags;
  metadata: Metadata;
  /** Secret *references* only (e.g. `env:BUYER_01_PASSWORD`). Never values. */
  secretRefs: Record<string, string>;
  activeLeaseId: string | null;
  quarantineReason: string | null;
  quarantinedAt: number | null;
  quarantinedBy: string | null;
  lastLeasedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Resource contract captured when the lease was created. */
export interface ResourceSnapshot {
  tags: Tags;
  metadata: Metadata;
  /** Secret references (e.g. `env:BUYER_01_PASSWORD`), never values. */
  secretRefs: Record<string, string>;
}

export interface LeaseRow {
  id: string;
  resourceId: string;
  pool: string;
  owner: string;
  principal: string;
  state: LeaseState;
  clientRequestId: string | null;
  purpose: string | null;
  context: Record<string, string> | null;
  snapshot: ResourceSnapshot;
  ttlMs: number;
  createdAt: number;
  expiresAt: number;
  lastHeartbeatAt: number;
  renewCount: number;
  endedAt: number | null;
  endReason: LeaseEndReason | null;
}

export interface LeaseFilter {
  state?: LeaseState;
  pool?: string;
  owner?: string;
  limit: number;
}

export interface EventRow {
  seq: number;
  at: number;
  type: string;
  pool: string | null;
  resourceId: string | null;
  leaseId: string | null;
  owner: string | null;
  details: Record<string, unknown> | null;
}
