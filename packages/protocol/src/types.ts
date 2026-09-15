/**
 * Framework-neutral wire types. Everything here is JSON-serialisable and free of secrets:
 * resources expose `secretKeys` (names) but never values.
 */

export type ResourceState = 'AVAILABLE' | 'LEASED' | 'QUARANTINED' | 'DISABLED';
export type LeaseState = 'ACTIVE' | 'RELEASED' | 'EXPIRED';
export type LeaseEndReason = 'RELEASED' | 'QUARANTINED' | 'EXPIRED' | 'FORCE_RELEASED';

export type MetadataValue = string | number | boolean;
/**
 * Public, non-sensitive, informational resource attributes (email, display name, notes).
 * Metadata is never used for matching.
 */
export type Metadata = Record<string, MetadataValue>;
/**
 * The matching surface. A resource is eligible for an acquisition when every requested tag
 * equals the resource's tag under the same key. Tag values are always strings.
 */
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
  /**
   * Whether the *configuration* wants this resource enabled. Runtime `state` may lag behind:
   * a LEASED resource with `enabledInConfig: false` becomes DISABLED when its lease ends.
   */
  enabledInConfig: boolean;
  tags: Tags;
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

/**
 * The resource contract as it was when the lease started. Configuration changes (new tags,
 * rotated secret references) do not alter a running lease; the next lease sees the new config.
 */
export interface LeaseResourceSnapshot {
  id: string;
  pool: string;
  tags: Tags;
  metadata: Metadata;
  /** Names of secrets available to this lease. Values are never included. */
  secretKeys: string[];
}

export interface LeaseView {
  leaseId: string;
  resourceId: string;
  pool: string;
  /**
   * Stable *logical* owner (e.g. `gha-483/chromium/worker-2`), chosen by the client for
   * diagnostics and accidental-misuse protection. Not an authorization credential.
   */
  owner: string;
  /**
   * Authenticated identity that acquired the lease: the API token name, or `local` in
   * insecure-local mode. Renew/release require both `principal` and `owner` to match
   * (or the `lease:admin` scope with `force`).
   */
  principal: string;
  /** Resource contract frozen at acquisition time. */
  resource: LeaseResourceSnapshot;
  state: LeaseState;
  ttlMs: number;
  createdAt: EpochMs;
  expiresAt: EpochMs;
  lastHeartbeatAt: EpochMs;
  /** Number of successful renewals (heartbeats). Kept on the lease instead of one event per heartbeat. */
  renewCount: number;
  endedAt?: EpochMs;
  endReason?: LeaseEndReason;
  clientRequestId?: string;
  purpose?: string;
  /** Caller-supplied context for debugging (test title, CI job URL, ...). Never secrets. */
  context?: Record<string, string>;
}

export interface AcquireRequest {
  pool: string;
  /** Stable logical owner. Clients derive this from run/project/worker; it is not a PID. */
  owner: string;
  tags?: Tags;
  /** Lease TTL. Defaults to the pool's `defaultTtl`, capped at the pool's `maxTtl`. */
  ttlMs?: number;
  /**
   * How long to wait for a compatible resource. Defaults to 0 (fail fast with POOL_EXHAUSTED);
   * adapters choose their own defaults (the Playwright fixture waits 60s).
   */
  waitTimeoutMs?: number;
  /** Idempotency key. A retry with the same key returns the same active lease. */
  clientRequestId?: string;
  purpose?: string;
  context?: Record<string, string>;
}

export interface AcquireResponse {
  /** The lease, including the frozen resource snapshot (`lease.resource`). */
  lease: LeaseView;
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
  /** Server clock (monotonic; immune to wall-clock jumps while the process runs). */
  now: EpochMs;
  /** `Date.now() - now`; large values mean the system clock jumped since startup. */
  wallClockDriftMs: number;
  db: { schemaVersion: number };
  auth: { mode: AuthMode };
  mcp: { http: boolean };
  config: { loadedAt: EpochMs; reloads: number };
}

export interface ListLeasesQuery {
  /** Defaults to ACTIVE. */
  state?: LeaseState | 'ALL';
  pool?: string;
  owner?: string;
  /** 1..1000, default 100. Newest first. */
  limit?: number;
}

export interface ListLeasesResponse {
  leases: LeaseView[];
}

/** Result of a configuration reload (SIGHUP or POST /v1/config/reload). */
export interface ConfigReloadResponse {
  pools: number;
  resources: number;
  registered: string[];
  updated: string[];
  disabled: string[];
  enabled: string[];
  absentPools: string[];
  /** e.g. "server.port changed; requires a restart" or "pools.x has no resources". */
  warnings: string[];
  loadedAt: EpochMs;
  reloads: number;
}

export interface PoolsResponse {
  pools: PoolSummary[];
}

export interface WhoAmIResponse {
  auth: AuthMode;
  principal: string;
  scopes: Scope[];
  /** Pools this identity may use; absent = all pools. */
  pools?: string[];
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
