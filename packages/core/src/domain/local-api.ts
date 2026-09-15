import type {
  AcquireRequest,
  AcquireResponse,
  AuthMode,
  CallOptions,
  EventsResponse,
  HealthResponse,
  LeaseView,
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
  SecretsApi,
  TestLeaseApi,
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
}

/**
 * In-process implementation of the framework-neutral API, bound to one authenticated
 * principal. The HTTP server creates one per request (from the token), the MCP Streamable
 * HTTP endpoint one per session, so REST, MCP and the CLI share one behaviour.
 */
export class LocalTestLeaseApi implements TestLeaseApi, SecretsApi {
  readonly service: LeaseService;
  readonly principal: string;
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
  ) {
    this.service = service;
    this.secrets = secrets;
    this.clock = clock;
    this.info = info;
    this.runtime = runtime;
    this.principal = principal;
  }

  /** Returns an API instance acting as another principal (used per request by the server). */
  as(principal: string): LocalTestLeaseApi {
    return new LocalTestLeaseApi(
      this.service,
      this.secrets,
      this.clock,
      this.info,
      this.runtime,
      principal,
    );
  }

  async health(): Promise<HealthResponse> {
    const now = this.clock.now();
    return {
      status: this.runtime.shuttingDown ? 'shutting_down' : 'ok',
      name: 'testlease',
      version: this.info.version,
      uptimeMs: now - this.info.startedAt,
      now,
      db: { schemaVersion: this.info.schemaVersion },
      auth: { mode: this.info.authMode },
      mcp: { http: this.info.mcpHttp },
    };
  }

  async listPools(): Promise<PoolSummary[]> {
    return this.service.listPools();
  }

  async getPool(pool: string): Promise<PoolDetail> {
    return this.service.getPool(pool);
  }

  async getResource(resourceId: string): Promise<ResourceView> {
    return this.service.getResource(resourceId);
  }

  acquire(req: AcquireRequest, opts?: CallOptions): Promise<AcquireResponse> {
    return this.service.acquire(req, { principal: this.principal, signal: opts?.signal });
  }

  async getLease(leaseId: string): Promise<LeaseView> {
    return this.service.getLease(leaseId);
  }

  async renew(leaseId: string, req: RenewRequest): Promise<RenewResponse> {
    return this.service.renew(leaseId, req, { principal: this.principal });
  }

  async release(leaseId: string, req: ReleaseRequest): Promise<ReleaseResponse> {
    return this.service.release(leaseId, req, { principal: this.principal });
  }

  async quarantine(leaseId: string, req: QuarantineRequest): Promise<QuarantineResponse> {
    return this.service.quarantine(leaseId, req, { principal: this.principal });
  }

  async quarantineResource(
    resourceId: string,
    req: { reason: string; force?: boolean },
  ): Promise<{ resource: ResourceView }> {
    return this.service.quarantineResource(resourceId, req, { principal: this.principal });
  }

  async restoreResource(resourceId: string): Promise<RestoreResponse> {
    return this.service.restoreResource(resourceId);
  }

  async listLeaseEvents(leaseId: string): Promise<EventsResponse> {
    return { events: this.service.listLeaseEvents(leaseId) };
  }

  async listResourceEvents(resourceId: string): Promise<EventsResponse> {
    return { events: this.service.listResourceEvents(resourceId) };
  }

  /** Resolves secret references for an active lease. Requires ownership; values are never logged. */
  async resolveSecrets(
    leaseId: string,
    req: ResolveSecretsRequest,
  ): Promise<ResolveSecretsResponse> {
    const { lease, refs } = this.service.secretRefsForLease(leaseId, req.owner, {
      principal: this.principal,
    });
    const secrets: Record<string, string> = {};
    for (const [name, ref] of Object.entries(refs)) {
      secrets[name] = await this.secrets.resolve(ref);
    }
    return { leaseId: lease.leaseId, resourceId: lease.resourceId, secrets };
  }
}
