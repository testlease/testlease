import type {
  AcquireRequest,
  AcquireResponse,
  ConfigReloadResponse,
  EventsResponse,
  HealthResponse,
  LeaseView,
  ListLeasesQuery,
  ListLeasesResponse,
  PoolDetail,
  PoolSummary,
  QuarantineRequest,
  QuarantineResponse,
  ReleaseRequest,
  ReleaseResponse,
  RenewRequest,
  RenewResponse,
  ResolveSecretsRequest,
  ResolveSecretsResponse,
  ResourceView,
  RestoreResponse,
} from './types.js';

export interface CallOptions {
  signal?: AbortSignal;
}

/**
 * The framework-neutral leasing API. Implemented in-process by `@testlease/core`
 * and over HTTP by `@testlease/client`. Adapters (Playwright, MCP, CLI) depend on
 * this interface only, so leasing behaviour is defined exactly once.
 *
 * Deliberately excludes secret resolution: see `SecretsApi`.
 */
export interface TestLeaseApi {
  health(opts?: CallOptions): Promise<HealthResponse>;
  listPools(opts?: CallOptions): Promise<PoolSummary[]>;
  getPool(pool: string, opts?: CallOptions): Promise<PoolDetail>;
  getResource(resourceId: string, opts?: CallOptions): Promise<ResourceView>;
  acquire(req: AcquireRequest, opts?: CallOptions): Promise<AcquireResponse>;
  getLease(leaseId: string, opts?: CallOptions): Promise<LeaseView>;
  renew(leaseId: string, req: RenewRequest, opts?: CallOptions): Promise<RenewResponse>;
  release(leaseId: string, req: ReleaseRequest, opts?: CallOptions): Promise<ReleaseResponse>;
  quarantine(
    leaseId: string,
    req: QuarantineRequest,
    opts?: CallOptions,
  ): Promise<QuarantineResponse>;
  restoreResource(resourceId: string, opts?: CallOptions): Promise<RestoreResponse>;
  listLeaseEvents(leaseId: string, opts?: CallOptions): Promise<EventsResponse>;
  listResourceEvents(resourceId: string, opts?: CallOptions): Promise<EventsResponse>;
  /** Lists leases (newest first). Not exposed to MCP identities by design. */
  listLeases(query?: ListLeasesQuery, opts?: CallOptions): Promise<ListLeasesResponse>;
}

/** Operator-only operations, separate from the leasing contract adapters implement. */
export interface AdminApi {
  reloadConfig(opts?: CallOptions): Promise<ConfigReloadResponse>;
}

/**
 * Secret resolution is a separate capability so that adapters which must never see
 * credentials (the MCP server) cannot reach it even by accident: they are typed
 * against `TestLeaseApi`, which has no such method.
 */
export interface SecretsApi {
  resolveSecrets(
    leaseId: string,
    req: ResolveSecretsRequest,
    opts?: CallOptions,
  ): Promise<ResolveSecretsResponse>;
}
