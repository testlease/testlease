import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  ErrorCodes,
  TestLeaseError,
  type AcquireRequest,
  type AcquireResponse,
  type AdminApi,
  type CallOptions,
  type ConfigReloadResponse,
  type ListLeasesQuery,
  type ListLeasesResponse,
  type EventsResponse,
  type HealthResponse,
  type LeaseView,
  type PoolDetail,
  type PoolsResponse,
  type PoolSummary,
  type QuarantineRequest,
  type QuarantineResourceRequest,
  type QuarantineResponse,
  type ReleaseRequest,
  type ReleaseResponse,
  type RenewRequest,
  type RenewResponse,
  type ResolveSecretsRequest,
  type ResolveSecretsResponse,
  type ResourceView,
  type RestoreResponse,
  type SecretsApi,
  type TestLeaseApi,
  type WhoAmIResponse,
} from '@testlease/protocol';
import { HttpTransport } from './http.js';
import { Lease, type HeartbeatOptions } from './lease.js';

export interface TestLeaseClientOptions {
  /** e.g. http://127.0.0.1:4747 */
  baseUrl: string;
  /** API token. Not needed in insecure-local mode. */
  token?: string;
  /** Default logical owner for acquisitions that do not specify one. */
  owner?: string;
  fetch?: typeof fetch;
  /** Timeout for non-waiting calls (default 15s). Waiting acquisitions add `waitTimeoutMs` on top. */
  requestTimeoutMs?: number;
  /** Connection-level retries for idempotent calls (default 2). */
  retries?: number;
  userAgent?: string;
}

export interface AcquireLeaseOptions extends Omit<AcquireRequest, 'owner'> {
  owner?: string;
  /** Start the automatic heartbeat (default true). */
  heartbeat?: boolean | HeartbeatOptions;
  signal?: AbortSignal;
}

/** A reasonable default owner for ad-hoc use: user@host/pid. Prefer a run/worker-derived owner in CI. */
export function defaultOwner(): string {
  const user = process.env.USER ?? process.env.USERNAME ?? 'user';
  return `${user}@${hostname()}/pid-${process.pid}`;
}

/**
 * HTTP client for TestLease. Implements the same `TestLeaseApi` contract as the in-process
 * engine, so adapters can be written against the interface and tested without a server.
 */
export class TestLeaseClient implements TestLeaseApi, SecretsApi, AdminApi {
  private readonly http: HttpTransport;
  private readonly owner: string;
  private readonly requestTimeoutMs: number;

  constructor(options: TestLeaseClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.http = new HttpTransport({
      baseUrl: options.baseUrl,
      token: options.token,
      fetch: options.fetch,
      userAgent: options.userAgent ?? `testlease-client/${CLIENT_VERSION}`,
      requestTimeoutMs: this.requestTimeoutMs,
      retries: options.retries ?? 2,
    });
    this.owner = options.owner ?? defaultOwner();
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  get defaultOwner(): string {
    return this.owner;
  }

  // ---- read ------------------------------------------------------------------------------------

  health(opts?: CallOptions): Promise<HealthResponse> {
    return this.http.request({
      method: 'GET',
      path: '/healthz',
      signal: opts?.signal,
      retry: true,
    });
  }

  whoami(opts?: CallOptions): Promise<WhoAmIResponse> {
    return this.http.request({
      method: 'GET',
      path: '/v1/whoami',
      signal: opts?.signal,
      retry: true,
    });
  }

  async listPools(opts?: CallOptions): Promise<PoolSummary[]> {
    const res = await this.http.request<PoolsResponse>({
      method: 'GET',
      path: '/v1/pools',
      signal: opts?.signal,
      retry: true,
    });
    return res.pools;
  }

  getPool(pool: string, opts?: CallOptions): Promise<PoolDetail> {
    return this.http.request({
      method: 'GET',
      path: `/v1/pools/${enc(pool)}`,
      signal: opts?.signal,
      retry: true,
    });
  }

  getResource(resourceId: string, opts?: CallOptions): Promise<ResourceView> {
    return this.http.request({
      method: 'GET',
      path: `/v1/resources/${enc(resourceId)}`,
      signal: opts?.signal,
      retry: true,
    });
  }

  getLease(leaseId: string, opts?: CallOptions): Promise<LeaseView> {
    return this.http.request({
      method: 'GET',
      path: `/v1/leases/${enc(leaseId)}`,
      signal: opts?.signal,
      retry: true,
    });
  }

  listLeaseEvents(leaseId: string, opts?: CallOptions): Promise<EventsResponse> {
    return this.http.request({
      method: 'GET',
      path: `/v1/leases/${enc(leaseId)}/events`,
      signal: opts?.signal,
      retry: true,
    });
  }

  listResourceEvents(resourceId: string, opts?: CallOptions): Promise<EventsResponse> {
    return this.http.request({
      method: 'GET',
      path: `/v1/resources/${enc(resourceId)}/events`,
      signal: opts?.signal,
      retry: true,
    });
  }

  listLeases(query: ListLeasesQuery = {}, opts?: CallOptions): Promise<ListLeasesResponse> {
    const params = new URLSearchParams();
    if (query.state) params.set('state', query.state);
    if (query.pool) params.set('pool', query.pool);
    if (query.owner) params.set('owner', query.owner);
    if (query.limit) params.set('limit', String(query.limit));
    const qs = params.toString();
    return this.http.request({
      method: 'GET',
      path: `/v1/leases${qs ? `?${qs}` : ''}`,
      signal: opts?.signal,
      retry: true,
    });
  }

  /** Re-reads the server's configuration file (requires `resource:admin`). */
  reloadConfig(opts?: CallOptions): Promise<ConfigReloadResponse> {
    return this.http.request({ method: 'POST', path: '/v1/config/reload', signal: opts?.signal });
  }

  /** Prometheus text exposition. */
  metrics(opts?: CallOptions): Promise<string> {
    return this.http.requestText({
      method: 'GET',
      path: '/metrics',
      signal: opts?.signal,
      retry: true,
    });
  }

  listRecentEvents(limit = 100, opts?: CallOptions): Promise<EventsResponse> {
    return this.http.request({
      method: 'GET',
      path: `/v1/events?limit=${limit}`,
      signal: opts?.signal,
      retry: true,
    });
  }

  // ---- write -----------------------------------------------------------------------------------

  /**
   * Low-level acquire returning the raw response. A `clientRequestId` is generated when absent so
   * that a retried request after a lost response yields the same lease instead of a second one.
   */
  acquire(req: AcquireRequest, opts?: CallOptions): Promise<AcquireResponse> {
    const body: AcquireRequest = {
      ...req,
      clientRequestId: req.clientRequestId ?? `tlc-${randomUUID()}`,
    };
    const wait = body.waitTimeoutMs ?? 0;
    return this.http.request({
      method: 'POST',
      path: '/v1/leases/acquire',
      body,
      signal: opts?.signal,
      timeoutMs: wait + this.requestTimeoutMs,
      retry: true,
      // Keep retrying through SERVER_SHUTTING_DOWN / connection failures for the whole wait
      // budget; the same clientRequestId makes every retry return the same lease if one was granted.
      retryUntil: Date.now() + wait + this.requestTimeoutMs,
    });
  }

  /** High-level acquire: returns a `Lease` handle with the heartbeat already running. */
  async acquireLease(options: AcquireLeaseOptions): Promise<Lease> {
    const { heartbeat, signal, owner, ...rest } = options;
    const res = await this.acquire({ ...rest, owner: owner ?? this.owner }, { signal });
    const lease = new Lease(this, res.lease);
    if (heartbeat !== false) lease.startHeartbeat(typeof heartbeat === 'object' ? heartbeat : {});
    return lease;
  }

  /** Wraps an existing lease (e.g. one acquired by another process) in a handle. */
  async attach(leaseId: string, opts?: { heartbeat?: boolean | HeartbeatOptions }): Promise<Lease> {
    const view = await this.getLease(leaseId);
    const lease = new Lease(this, view);
    if (opts?.heartbeat && view.state === 'ACTIVE')
      lease.startHeartbeat(typeof opts.heartbeat === 'object' ? opts.heartbeat : {});
    return lease;
  }

  renew(leaseId: string, req: RenewRequest, opts?: CallOptions): Promise<RenewResponse> {
    return this.http.request({
      method: 'POST',
      path: `/v1/leases/${enc(leaseId)}/renew`,
      body: req,
      signal: opts?.signal,
      retry: true,
    });
  }

  release(leaseId: string, req: ReleaseRequest, opts?: CallOptions): Promise<ReleaseResponse> {
    return this.http.request({
      method: 'POST',
      path: `/v1/leases/${enc(leaseId)}/release`,
      body: req,
      signal: opts?.signal,
      retry: true,
    });
  }

  quarantine(
    leaseId: string,
    req: QuarantineRequest,
    opts?: CallOptions,
  ): Promise<QuarantineResponse> {
    return this.http.request({
      method: 'POST',
      path: `/v1/leases/${enc(leaseId)}/quarantine`,
      body: req,
      signal: opts?.signal,
    });
  }

  quarantineResource(
    resourceId: string,
    req: QuarantineResourceRequest,
    opts?: CallOptions,
  ): Promise<{ resource: ResourceView }> {
    return this.http.request({
      method: 'POST',
      path: `/v1/resources/${enc(resourceId)}/quarantine`,
      body: req,
      signal: opts?.signal,
    });
  }

  restoreResource(resourceId: string, opts?: CallOptions): Promise<RestoreResponse> {
    return this.http.request({
      method: 'POST',
      path: `/v1/resources/${enc(resourceId)}/restore`,
      signal: opts?.signal,
      retry: true,
    });
  }

  /** Requires the `secrets:resolve` scope and lease ownership. Never log the result. */
  resolveSecrets(
    leaseId: string,
    req: ResolveSecretsRequest,
    opts?: CallOptions,
  ): Promise<ResolveSecretsResponse> {
    return this.http.request({
      method: 'POST',
      path: `/v1/leases/${enc(leaseId)}/secrets`,
      body: req,
      signal: opts?.signal,
      retry: true,
    });
  }
}

export const CLIENT_VERSION = '0.1.0';

function enc(segment: string): string {
  if (!segment)
    throw new TestLeaseError(ErrorCodes.INVALID_REQUEST, 'identifier must not be empty');
  return encodeURIComponent(segment);
}
