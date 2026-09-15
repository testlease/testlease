import type { LeaseEvent, LeaseEventType, LeaseView, ResourceView } from '@testlease/protocol';
import type { EventRow, LeaseRow, ResourceRow } from '../store/rows.js';

export function toLeaseView(row: LeaseRow): LeaseView {
  const view: LeaseView = {
    leaseId: row.id,
    resourceId: row.resourceId,
    pool: row.pool,
    owner: row.owner,
    principal: row.principal,
    resource: {
      id: row.resourceId,
      pool: row.pool,
      tags: row.snapshot.tags,
      metadata: row.snapshot.metadata,
      secretKeys: Object.keys(row.snapshot.secretRefs).sort(),
    },
    state: row.state,
    ttlMs: row.ttlMs,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
  };
  if (row.endedAt !== null) view.endedAt = row.endedAt;
  if (row.endReason !== null) view.endReason = row.endReason;
  if (row.clientRequestId !== null) view.clientRequestId = row.clientRequestId;
  if (row.purpose !== null) view.purpose = row.purpose;
  if (row.context !== null) view.context = row.context;
  return view;
}

/** Public view: secret *names* only. Values never leave the secret resolver path. */
export function toResourceView(row: ResourceRow, activeLease?: LeaseRow | null): ResourceView {
  const view: ResourceView = {
    id: row.id,
    pool: row.pool,
    state: row.state,
    enabledInConfig: row.enabledInConfig,
    tags: row.tags,
    metadata: row.metadata,
    secretKeys: Object.keys(row.secretRefs).sort(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.quarantineReason !== null) {
    view.quarantine = {
      reason: row.quarantineReason,
      at: row.quarantinedAt ?? row.updatedAt,
      ...(row.quarantinedBy ? { by: row.quarantinedBy } : {}),
    };
  }
  if (row.lastLeasedAt !== null) view.lastLeasedAt = row.lastLeasedAt;
  if (activeLease) {
    view.activeLease = {
      leaseId: activeLease.id,
      owner: activeLease.owner,
      createdAt: activeLease.createdAt,
      expiresAt: activeLease.expiresAt,
      ...(activeLease.purpose ? { purpose: activeLease.purpose } : {}),
    };
  }
  return view;
}

export function toEventView(row: EventRow): LeaseEvent {
  const view: LeaseEvent = { seq: row.seq, at: row.at, type: row.type as LeaseEventType };
  if (row.pool !== null) view.pool = row.pool;
  if (row.resourceId !== null) view.resourceId = row.resourceId;
  if (row.leaseId !== null) view.leaseId = row.leaseId;
  if (row.owner !== null) view.owner = row.owner;
  if (row.details !== null) view.details = row.details;
  return view;
}
