/**
 * Framework-neutral wire types. Everything here is JSON-serialisable and free of secrets:
 * resources expose `secretKeys` (names) but never values.
 */

export type ResourceState = 'AVAILABLE' | 'LEASED' | 'QUARANTINED' | 'DISABLED';
export type LeaseState = 'ACTIVE' | 'RELEASED' | 'EXPIRED';
export type LeaseEndReason = 'RELEASED' | 'QUARANTINED' | 'EXPIRED' | 'FORCE_RELEASED';

export type MetadataValue = string | number | boolean;
/** Public, non-sensitive resource attributes. Also the matching surface for `tags`. */
export type Metadata = Record<string, MetadataValue>;
/** Requested attributes. A resource matches when every tag equals `String(metadata[key])`. */
export type Tags = Record<string, string>;

/** Epoch milliseconds, always produced by the server clock. */
export type EpochMs = number;

export interface PoolCounts {
  available: number;
  leased: number;
  quarantined: number;
  disabled: number;
  total: number;
}

export interface PoolSummary {
  name: string;
  description?: string;
  defaultTtlMs: number;
  maxTtlMs: number;
  counts: PoolCounts;
  /** Number of acquisition requests currently waiting on this pool (in this server process). */
  waiting: number;
}

export interface ActiveLeaseRef {
  leaseId: string;
  owner: string;
  createdAt: EpochMs;
  expiresAt: EpochMs;
  purpose?: string;
}

export interface ResourceView {
  id: string;
  pool: string;
  state: ResourceState;
  /** Present in configuration. When false the resource is DISABLED after its current lease ends. */
  enabled: boolean;
  metadata: Metadata;
  /** Names of configured secrets. Values are never included in any view. */
  secretKeys: string[];
  quarantine?: { reason: string; at: EpochMs; by?: string };
  activeLease?: ActiveLeaseRef;
  lastLeasedAt?: EpochMs;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export interface WaiterView {
  owner: string;
  tags: Tags;
  waitingForMs: number;
  purpose?: string;
}

export interface PoolDetail extends PoolSummary {
  resources: ResourceView[];
  waiters: WaiterView[];
}

export interface LeaseView {
  leaseId: string;
  resourceId: string;
  pool: string;
  /** Stable logical owner (e.g. `gha-483/chromium/worker-2`). Required for renew/release. */
  owner: string;
  state: LeaseState;
  ttlMs: number;
  createdAt: EpochMs;
  expiresAt: EpochMs;
  lastHeartbeatAt: EpochMs;
  endedAt?: EpochMs;
  endReason?: LeaseEndReason;
  clientRequestId?: string;
  purpose?: string;
  /** Caller-supplied context for debugging (test title, CI job URL, ...). Never secrets. */
  metadata?: Record<string, string>;
}

export interface AcquireRequest {
  pool: string;
  /** Stable logical owner. Clients derive this from run/project/worker; it is not a PID. */
  owner: string;
  tags?: Tags;
  /** Lease TTL. Defaults to the pool's `defaultTtl`, capped at the pool's `maxTtl`. */
  ttlMs?: number;
  /** How long to wait for a compatible resource. 0 = fail fast with POOL_EXHAUSTED. */
  waitTimeoutMs?: number;
  /** Idempotency key. A retry with the same key returns the same active lease. */
  clientRequestId?: string;
  purpose?: string;
  metadata?: Record<string, string>;
}

export interface AcquireResponse {
  lease: LeaseView;
  resource: ResourceView;
  /** True when an existing active lease was returned because of `clientRequestId`. */
  reused: boolean;
  /** How long the request waited before a resource was assigned. */
  waitedMs: number;
}

export interface RenewRequest {
  owner: string;
  /** New TTL from now. Defaults to the lease's current TTL. */
  ttlMs?: number;
}

export interface RenewResponse {
  lease: LeaseView;
}

export interface ReleaseRequest {
  owner: string;
  /** Administrative override of the ownership check. Requires the `lease:admin` scope. */
  force?: boolean;
}

export type ReleaseOutcome = 'released' | 'already_released' | 'already_expired';

export interface ReleaseResponse {
  lease: LeaseView;
  outcome: ReleaseOutcome;
}

export interface QuarantineRequest {
  owner: string;
  reason: string;
  force?: boolean;
}

export interface QuarantineResponse {
  lease: LeaseView;
  resource: ResourceView;
}

export interface QuarantineResourceRequest {
  reason: string;
  /** End the active lease (if any) instead of failing with RESOURCE_LEASED. */
  force?: boolean;
}

export interface RestoreResponse {
  resource: ResourceView;
}

export interface ResolveSecretsRequest {
  owner: string;
}

export interface ResolveSecretsResponse {
  leaseId: string;
  resourceId: string;
  secrets: Record<string, string>;
}

export const LeaseEventTypes = [
  'RESOURCE_REGISTERED',
  'RESOURCE_UPDATED',
  'RESOURCE_DISABLED',
  'RESOURCE_ENABLED',
  'LEASE_ACQUIRED',
  'LEASE_REUSED',
  'LEASE_RENEWED',
  'LEASE_RELEASED',
  'LEASE_EXPIRED',
  'RESOURCE_QUARANTINED',
  'RESOURCE_RESTORED',
  'ACQUIRE_TIMEOUT',
  'LEASE_SECRETS_RESOLVED',
] as const;

export type LeaseEventType = (typeof LeaseEventTypes)[number];

export interface LeaseEvent {
  seq: number;
  at: EpochMs;
  type: LeaseEventType;
  pool?: string;
  resourceId?: string;
  leaseId?: string;
  owner?: string;
  details?: Record<string, unknown>;
}

export interface EventsResponse {
  events: LeaseEvent[];
}

export type AuthMode = 'insecure-local' | 'token';

export interface HealthResponse {
  status: 'ok' | 'shutting_down';
  name: 'testlease';
  version: string;
  uptimeMs: number;
  now: EpochMs;
  db: { schemaVersion: number };
  auth: { mode: AuthMode };
  mcp: { http: boolean };
}

export interface PoolsResponse {
  pools: PoolSummary[];
}

export interface WhoAmIResponse {
  auth: AuthMode;
  principal: string;
  scopes: Scope[];
}

export const Scopes = [
  'lease:read',
  'lease:write',
  'lease:admin',
  'pool:read',
  'resource:admin',
  'secrets:resolve',
] as const;

export type Scope = (typeof Scopes)[number];
