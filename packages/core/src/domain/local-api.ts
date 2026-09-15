import {
  ErrorCodes,
  TestLeaseError,
  type AcquireRequest,
  type AcquireResponse,
  type AdminApi,
  type AuthMode,
  type CallOptions,
  type ConfigReloadResponse,
  type EventsResponse,
  type HealthResponse,
  type LeaseView,
  type ListLeasesQuery,
  type ListLeasesResponse,
  type PoolDetail,
  type PoolSummary,
  type QuarantineRequest,
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
} from '@testlease/protocol';
import type { Clock } from '../clock.js';
import type { SecretResolverRegistry } from '../secrets/resolver.js';
import type { LeaseService } from './lease-service.js';

export interface LocalApiInfo {
  version: string;
  startedAt: number;
  schemaVersion: number;
  authMode: AuthMode;
  mcpHttp: boolean;
}

/** Shared, mutable runtime state visible to every principal-bound API instance. */
export interface LocalApiRuntime {
  shuttingDown: boolean;
  configLoadedAt: number;
  reloads: number;
  /** Installed by the engine; performs a configuration reload. */
  reload?: () => Promise<ConfigReloadResponse>;
  /** Wall-clock drift reported in /healthz (0 when the engine uses the system clock). */
  wallDriftMs?: () => number;
}

export interface PrincipalOptions {
  /** Pools this identity may use. `null` = all pools. */
  pools?: ReadonlySet<string> | null;
}

/**
 * In-process implementation of the framework-neutral API, bound to one authenticated
 * principal and (optionally) to an allow-list of pools. The HTTP server creates one per request
 * (from the token), the MCP Streamable HTTP endpoint one per session, so REST, MCP and the CLI
 * share one behaviour.
 */
export class LocalTestLeaseApi implements TestLeaseApi, SecretsApi, AdminApi {
  readonly service: LeaseService;
  readonly principal: string;
  readonly pools: ReadonlySet<string> | null;
  private readonly secrets: SecretResolverRegistry;
  private readonly clock: Clock;
  private readonly info: LocalApiInfo;
  private readonly runtime: LocalApiRuntime;

  constructor(
    service: LeaseService,
    secrets: SecretResolverRegistry,
    clock: Clock,
    info: LocalApiInfo,
    runtime: LocalApiRuntime,
    principal: string,
    options: PrincipalOptions = {},
  ) {
    this.service = service;
    this.secrets = secrets;
    this.clock = clock;
    this.info = info;
    this.runtime = runtime;
    this.principal = principal;
    this.pools = options.pools ?? null;
  }

  /** Returns an API instance acting as another principal (used per request by the server). */
  as(principal: string, options: PrincipalOptions = {}): LocalTestLeaseApi {
    return new LocalTestLeaseApi(
      this.service,
      this.secrets,
      this.clock,
      this.info,
      this.runtime,
      principal,
      options,
    );
  }

  private assertPool(pool: string): void {
    if (this.pools && !this.pools.has(pool)) {
      throw new TestLeaseError(
        ErrorCodes.FORBIDDEN,
        `Token "${this.principal}" is restricted to pools ${[...this.pools].join(', ')}; "${pool}" is not among them.`,
        { principal: this.principal, pool, allowedPools: [...this.pools] },
      );
    }
  }

  private leasePool(leaseId: string): LeaseView {
    const lease = this.service.getLease(leaseId);
    this.assertPool(lease.pool);
    return lease;
  }

  private resourcePool(resourceId: string): ResourceView {
    const resource = this.service.getResource(resourceId);
    this.assertPool(resource.pool);
    return resource;
  }

  async health(): Promise<HealthResponse> {
    const now = this.clock.now();
    return {
      status: this.runtime.shuttingDown ? 'shutting_down' : 'ok',
      name: 'testlease',
      version: this.info.version,
      uptimeMs: now - this.info.startedAt,
      now,
      wallClockDriftMs: this.runtime.wallDriftMs?.() ?? 0,
      db: { schemaVersion: this.info.schemaVersion },
      auth: { mode: this.info.authMode },
      mcp: { http: this.info.mcpHttp },
      config: { loadedAt: this.runtime.configLoadedAt, reloads: this.runtime.reloads },
    };
  }

  async listPools(): Promise<PoolSummary[]> {
    const all = this.service.listPools();
    return this.pools ? all.filter((p) => this.pools!.has(p.name)) : all;
  }

  async getPool(pool: string): Promise<PoolDetail> {
    this.assertPool(pool);
    return this.service.getPool(pool);
  }

  async getResource(resourceId: string): Promise<ResourceView> {
    return this.resourcePool(resourceId);
  }

  async acquire(req: AcquireRequest, opts?: CallOptions): Promise<AcquireResponse> {
    // `async` so a forbidden pool rejects the promise instead of throwing synchronously.
    if (typeof req?.pool === 'string') this.assertPool(req.pool);
    return this.service.acquire(req, { principal: this.principal, signal: opts?.signal });
  }

  async getLease(leaseId: string): Promise<LeaseView> {
    return this.leasePool(leaseId);
  }

  async listLeases(query: ListLeasesQuery = {}): Promise<ListLeasesResponse> {
    if (query.pool) this.assertPool(query.pool);
    const leases = this.service.listLeases(query);
    return { leases: this.pools ? leases.filter((l) => this.pools!.has(l.pool)) : leases };
  }

  async renew(leaseId: string, req: RenewRequest): Promise<RenewResponse> {
    this.leasePool(leaseId);
    return this.service.renew(leaseId, req, { principal: this.principal });
  }

  async release(leaseId: string, req: ReleaseRequest): Promise<ReleaseResponse> {
    this.leasePool(leaseId);
    return this.service.release(leaseId, req, { principal: this.principal });
  }

  async quarantine(leaseId: string, req: QuarantineRequest): Promise<QuarantineResponse> {
    this.leasePool(leaseId);
    return this.service.quarantine(leaseId, req, { principal: this.principal });
  }

  async quarantineResource(
    resourceId: string,
    req: { reason: string; force?: boolean },
  ): Promise<{ resource: ResourceView }> {
    this.resourcePool(resourceId);
    return this.service.quarantineResource(resourceId, req, { principal: this.principal });
  }

  async restoreResource(resourceId: string): Promise<RestoreResponse> {
    this.resourcePool(resourceId);
    return this.service.restoreResource(resourceId);
  }

  async listLeaseEvents(leaseId: string): Promise<EventsResponse> {
    this.leasePool(leaseId);
    return { events: this.service.listLeaseEvents(leaseId) };
  }

  async listResourceEvents(resourceId: string): Promise<EventsResponse> {
    this.resourcePool(resourceId);
    return { events: this.service.listResourceEvents(resourceId) };
  }

  /** Resolves secret references for an active lease. Requires ownership; values are never logged. */
  async resolveSecrets(
    leaseId: string,
    req: ResolveSecretsRequest,
  ): Promise<ResolveSecretsResponse> {
    this.leasePool(leaseId);
    const { lease, refs } = this.service.secretRefsForLease(leaseId, req.owner, {
      principal: this.principal,
    });
    const secrets: Record<string, string> = {};
    for (const [name, ref] of Object.entries(refs)) {
      secrets[name] = await this.secrets.resolve(ref);
    }
    return { leaseId: lease.leaseId, resourceId: lease.resourceId, secrets };
  }

  /** Re-reads and applies the configuration. Operator-only (`resource:admin`). */
  async reloadConfig(): Promise<ConfigReloadResponse> {
    if (!this.runtime.reload) {
      throw new TestLeaseError(
        ErrorCodes.CONFIG_INVALID,
        'This server was started without a reloadable configuration source.',
      );
    }
    return this.runtime.reload();
  }
}
