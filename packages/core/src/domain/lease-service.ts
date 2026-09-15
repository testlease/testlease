import {
  ErrorCodes,
  TestLeaseError,
  type AcquireRequest,
  type AcquireResponse,
  type LeaseEvent,
  type LeaseView,
  type ListLeasesQuery,
  type PoolDetail,
  type PoolSummary,
  type QuarantineRequest,
  type QuarantineResourceRequest,
  type QuarantineResponse,
  type ReleaseRequest,
  type ReleaseResponse,
  type RenewRequest,
  type RenewResponse,
  type ResourceView,
  type RestoreResponse,
  type Tags,
  type WaiterView,
} from '@testlease/protocol';
import { type Clock, systemClock } from '../clock.js';
import { formatDuration } from '../duration.js';
import { newLeaseId } from '../ids.js';
import { type Logger, noopLogger } from '../logger.js';
import type { LeaseFilter, LeaseRow, ResourceRow } from '../store/rows.js';
import type { SqliteStore } from '../store/sqlite-store.js';
import {
  acquireRequestSchema,
  idSchema,
  ownerSchema,
  principalSchema,
  quarantineRequestSchema,
  quarantineResourceRequestSchema,
  releaseRequestSchema,
  renewRequestSchema,
  validate,
} from '../validation.js';
import { type AcquireDiagnostic, formatAcquireDiagnostic } from './diagnostics.js';
import { knownTagValues, matchesTags } from './matching.js';
import { toEventView, toLeaseView, toResourceView } from './views.js';
import { WaitQueue, type Waiter } from './wait-queue.js';

/**
 * Core and REST default: fail fast. Adapters pick their own defaults (Playwright waits 60s)
 * so a generic `acquire()` never blocks silently.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 0;

/** Principal used when authentication is disabled (insecure-local mode) or in-process tests. */
export const LOCAL_PRINCIPAL = 'local';

/** The authenticated identity performing an operation. Derived by the server, never by clients. */
export interface Actor {
  principal: string;
}

export interface LeaseServiceOptions {
  store: SqliteStore;
  clock?: Clock;
  logger?: Logger;
  /** Upper bound applied to every request's `waitTimeoutMs`. */
  maxWaitMs?: number;
  /** Longest the reaper sleeps between checks even if no lease is due sooner (clock-jump safety). */
  reaperMaxDelayMs?: number;
  leaseIdFactory?: () => string;
  /** Record a LEASE_RENEWED event per heartbeat (default false; `renewCount` is always kept). */
  recordRenewals?: boolean;
}

/** In-process counters since start, per pool (for /metrics). State gauges come from the store. */
export interface PoolCounters {
  acquired: number;
  reused: number;
  released: number;
  expired: number;
  quarantined: number;
  timeouts: number;
  exhausted: number;
  waitMsSum: number;
  waitCount: number;
}

interface NormalizedAcquire {
  pool: string;
  owner: string;
  principal: string;
  tags: Tags;
  ttlMs: number | undefined;
  waitTimeoutMs: number;
  clientRequestId: string | null;
  purpose: string | null;
  context: Record<string, string> | null;
}

export interface AcquireOptions extends Partial<Actor> {
  signal?: AbortSignal;
}

/**
 * The leasing engine. All mutations run inside a single synchronous SQLite transaction
 * (BEGIN IMMEDIATE), so an acquire is atomic with respect to every other operation in this
 * process and, thanks to SQLite's file lock, in any other process using the same database.
 *
 * Waiting is implemented as an in-process FIFO queue that is re-evaluated whenever a resource
 * becomes free (release, expiry, restore). Nothing polls the database in a loop.
 */
export class LeaseService {
  private readonly store: SqliteStore;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly maxWaitMs: number;
  private readonly reaperMaxDelayMs: number;
  private readonly leaseIdFactory: () => string;
  private readonly waiters = new WaitQueue<NormalizedAcquire, AcquireResponse>();
  private readonly counters = new Map<string, PoolCounters>();
  recordRenewals: boolean;

  private reaperTimer: NodeJS.Timeout | null = null;
  private started = false;
  private stopped = false;
  private pumping = false;
  private readonly pendingPumps = new Set<string>();

  constructor(options: LeaseServiceOptions) {
    this.store = options.store;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? noopLogger;
    this.maxWaitMs = options.maxWaitMs ?? 10 * 60_000;
    this.reaperMaxDelayMs = options.reaperMaxDelayMs ?? 30_000;
    this.leaseIdFactory = options.leaseIdFactory ?? newLeaseId;
    this.recordRenewals = options.recordRenewals ?? false;
  }

  private counter(pool: string): PoolCounters {
    let c = this.counters.get(pool);
    if (!c) {
      c = {
        acquired: 0,
        reused: 0,
        released: 0,
        expired: 0,
        quarantined: 0,
        timeouts: 0,
        exhausted: 0,
        waitMsSum: 0,
        waitCount: 0,
      };
      this.counters.set(pool, c);
    }
    return c;
  }

  /** Snapshot of in-process counters (since start) keyed by pool. */
  metrics(): Record<string, PoolCounters> {
    return Object.fromEntries([...this.counters].map(([k, v]) => [k, { ...v }]));
  }

  /** Re-evaluates every pool with waiters (after a configuration reload added or restored resources). */
  notifyAllPools(): void {
    this.onStateChanged(this.waiters.pools());
    this.scheduleReaper();
  }

  /** Lists leases newest first; `state` defaults to ACTIVE, `ALL` disables the state filter. */
  listLeases(query: ListLeasesQuery = {}): LeaseView[] {
    this.expireDue();
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 100), 1), 1000);
    const filter: LeaseFilter = { limit };
    const state = query.state ?? 'ACTIVE';
    if (state !== 'ALL') filter.state = state;
    if (query.pool) filter.pool = validate(idSchema, query.pool, 'pool');
    if (query.owner) filter.owner = validate(ownerSchema, query.owner, 'owner');
    return this.store.listLeases(filter).map(toLeaseView);
  }

  /** Deletes events and ended leases older than `retentionMs`. Returns what was removed. */
  pruneHistory(retentionMs: number): { events: number; leases: number } {
    const before = this.clock.now() - retentionMs;
    const removed = this.store.transaction(() => this.store.pruneHistory(before));
    if (removed.events || removed.leases) {
      this.logger.info({ event: 'history.pruned', ...removed, retentionMs }, 'history pruned');
    }
    return removed;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Expires anything overdue (e.g. after a restart) and arms the expiry timer. */
  start(): void {
    this.started = true;
    this.stopped = false;
    this.expireDue();
    this.scheduleReaper();
  }

  /**
   * Stops timers and fails every waiting acquisition with SERVER_SHUTTING_DOWN.
   * Active leases are deliberately left untouched: a server restart does not mean the
   * workers stopped using their resources.
   */
  stop(): void {
    this.stopped = true;
    if (this.reaperTimer) {
      clearTimeout(this.reaperTimer);
      this.reaperTimer = null;
    }
    for (const waiter of this.waiters.drain()) {
      waiter.reject(
        new TestLeaseError(
          ErrorCodes.SERVER_SHUTTING_DOWN,
          'TestLease is shutting down; retry the acquisition against the restarted server.',
          { pool: waiter.pool },
        ),
      );
    }
  }

  get waitingCount(): number {
    return this.waiters.count();
  }

  // -------------------------------------------------------------------- reads

  listPools(): PoolSummary[] {
    this.expireDue();
    return this.store
      .listPools()
      .filter((p) => p.present)
      .map((p) => this.poolSummary(p.name));
  }

  getPool(name: string): PoolDetail {
    this.expireDue();
    const pool = this.store.getPool(name);
    if (!pool || !pool.present) throw this.poolNotFound(name);
    const activeLeases = new Map(this.store.listActiveLeases(name).map((l) => [l.resourceId, l]));
    const resources = this.store
      .listResources(name)
      .map((r) => toResourceView(r, activeLeases.get(r.id) ?? null));
    const now = this.clock.now();
    const waiters: WaiterView[] = this.waiters.list(name).map((w) => ({
      owner: w.owner,
      tags: w.tags,
      waitingForMs: now - w.enqueuedAt,
      ...(w.purpose ? { purpose: w.purpose } : {}),
    }));
    return { ...this.poolSummary(name), resources, waiters };
  }

  getResource(resourceId: string): ResourceView {
    this.expireDue();
    const row = this.store.getResource(resourceId);
    if (!row) {
      throw new TestLeaseError(
        ErrorCodes.RESOURCE_NOT_FOUND,
        `Resource "${resourceId}" does not exist.`,
        {
          resourceId,
        },
      );
    }
    return toResourceView(
      row,
      row.activeLeaseId ? this.store.getActiveLeaseForResource(row.id) : null,
    );
  }

  getLease(leaseId: string): LeaseView {
    this.expireDue();
    return toLeaseView(this.requireLease(leaseId));
  }

  listLeaseEvents(leaseId: string): LeaseEvent[] {
    this.requireLease(leaseId);
    return this.store.eventsByLease(leaseId).map(toEventView);
  }

  listResourceEvents(resourceId: string, limit = 200): LeaseEvent[] {
    if (!this.store.getResource(resourceId)) {
      throw new TestLeaseError(
        ErrorCodes.RESOURCE_NOT_FOUND,
        `Resource "${resourceId}" does not exist.`,
        {
          resourceId,
        },
      );
    }
    return this.store.eventsByResource(resourceId, limit).map(toEventView);
  }

  listRecentEvents(limit = 100): LeaseEvent[] {
    return this.store.recentEvents(limit).map(toEventView);
  }

  // ------------------------------------------------------------------ acquire

  /**
   * Acquires a lease, waiting up to `waitTimeoutMs` for a compatible resource.
   * Resolution order for waiters is FIFO per pool (see WaitQueue).
   */
  async acquire(input: AcquireRequest, options: AcquireOptions = {}): Promise<AcquireResponse> {
    const req = this.normalizeAcquire(input, options.principal);
    this.assertNotStopped();
    const startedAt = this.clock.now();

    const immediate = this.runAcquireAttempt(req, startedAt, 0);
    if (immediate) return immediate;

    if (req.waitTimeoutMs <= 0) {
      this.store.insertEvent({
        at: startedAt,
        type: 'ACQUIRE_TIMEOUT',
        pool: req.pool,
        owner: req.owner,
        details: { waitedMs: 0, tags: req.tags, immediate: true },
      });
      this.counter(req.pool).exhausted++;
      throw this.exhaustedError(req, 0, ErrorCodes.POOL_EXHAUSTED);
    }
    if (options.signal?.aborted) throw this.abortedError(req, 0);

    return new Promise<AcquireResponse>((resolve, reject) => {
      const waiter: Waiter<NormalizedAcquire, AcquireResponse> = {
        id: this.waiters.allocateId(),
        pool: req.pool,
        owner: req.owner,
        tags: req.tags,
        purpose: req.purpose ?? undefined,
        request: req,
        enqueuedAt: startedAt,
        resolve,
        reject,
        cleanup: null,
      };
      const timer = setTimeout(() => {
        if (!this.waiters.remove(waiter)) return;
        const waitedMs = this.clock.now() - startedAt;
        this.store.insertEvent({
          at: this.clock.now(),
          type: 'ACQUIRE_TIMEOUT',
          pool: req.pool,
          owner: req.owner,
          details: { waitedMs, tags: req.tags, ...(req.purpose ? { purpose: req.purpose } : {}) },
        });
        this.logger.warn(
          { event: 'lease.acquire_timeout', pool: req.pool, owner: req.owner, waitedMs },
          'acquisition timed out',
        );
        this.counter(req.pool).timeouts++;
        reject(this.exhaustedError(req, waitedMs, ErrorCodes.ACQUIRE_TIMEOUT));
      }, req.waitTimeoutMs);
      const onAbort = () => {
        if (!this.waiters.remove(waiter)) return;
        const waitedMs = this.clock.now() - startedAt;
        this.logger.info(
          { event: 'lease.acquire_aborted', pool: req.pool, owner: req.owner, waitedMs },
          'acquisition cancelled by caller',
        );
        reject(this.abortedError(req, waitedMs));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      waiter.cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      this.waiters.add(waiter);
      this.logger.debug(
        {
          event: 'lease.waiting',
          pool: req.pool,
          owner: req.owner,
          position: this.waiters.count(req.pool),
        },
        'no resource available; waiting',
      );
    });
  }

  /** Single synchronous attempt. Returns null when nothing compatible is available right now. */
  tryAcquire(input: AcquireRequest, actor?: Actor): AcquireResponse | null {
    const req = this.normalizeAcquire(input, actor?.principal);
    this.assertNotStopped();
    return this.runAcquireAttempt(req, this.clock.now(), 0);
  }

  private runAcquireAttempt(
    req: NormalizedAcquire,
    now: number,
    waitedMs: number,
  ): AcquireResponse | null {
    const touched: string[] = [];
    let result: AcquireResponse | null;
    try {
      result = this.store.transaction(() => this.acquireInTx(req, now, waitedMs, touched));
    } finally {
      // Expired leases freed inside the transaction may unblock other pools' waiters.
      this.onStateChanged(touched);
    }
    if (result) {
      const c = this.counter(req.pool);
      if (result.reused) c.reused++;
      else {
        c.acquired++;
        c.waitMsSum += waitedMs;
        c.waitCount++;
      }
      this.logger.info(
        {
          event: result.reused ? 'lease.reused' : 'lease.acquired',
          pool: req.pool,
          resourceId: result.lease.resourceId,
          leaseId: result.lease.leaseId,
          owner: req.owner,
          principal: req.principal,
          waitedMs,
          ttlMs: result.lease.ttlMs,
        },
        result.reused ? 'existing lease returned for client request id' : 'lease acquired',
      );
      this.scheduleReaper();
    }
    return result;
  }

  private acquireInTx(
    req: NormalizedAcquire,
    now: number,
    waitedMs: number,
    touchedPools: string[],
  ): AcquireResponse | null {
    for (const expired of this.expireDueInTx(now)) touchedPools.push(expired.pool);

    const pool = this.store.getPool(req.pool);
    if (!pool || !pool.present) throw this.poolNotFound(req.pool);

    const ttlMs = req.ttlMs ?? pool.defaultTtlMs;
    if (ttlMs > pool.maxTtlMs) {
      throw new TestLeaseError(
        ErrorCodes.INVALID_REQUEST,
        `Requested TTL ${formatDuration(ttlMs)} exceeds the maximum TTL ${formatDuration(pool.maxTtlMs)} of pool "${req.pool}". Renew the lease periodically instead of requesting a long TTL.`,
        { pool: req.pool, ttlMs, maxTtlMs: pool.maxTtlMs },
      );
    }

    if (req.clientRequestId) {
      const existing = this.store.findActiveLeaseByClientRequestId(req.clientRequestId);
      if (existing) {
        // The lease's frozen snapshot is the contract the retry must be satisfied by.
        const compatible =
          existing.pool === req.pool &&
          existing.owner === req.owner &&
          existing.principal === req.principal &&
          matchesTags(existing.snapshot.tags, req.tags);
        if (!compatible) {
          throw new TestLeaseError(
            ErrorCodes.IDEMPOTENCY_CONFLICT,
            `clientRequestId "${req.clientRequestId}" is already bound to active lease ${existing.id} (pool "${existing.pool}", owner "${existing.owner}", principal "${existing.principal}") which does not satisfy this request. Use a new clientRequestId for a different request.`,
            {
              clientRequestId: req.clientRequestId,
              leaseId: existing.id,
              existingPool: existing.pool,
              existingOwner: existing.owner,
              existingPrincipal: existing.principal,
              existingResourceId: existing.resourceId,
            },
          );
        }
        this.store.insertEvent({
          at: now,
          type: 'LEASE_REUSED',
          pool: req.pool,
          resourceId: existing.resourceId,
          leaseId: existing.id,
          owner: req.owner,
          details: { clientRequestId: req.clientRequestId, waitedMs },
        });
        return { lease: toLeaseView(existing), reused: true, waitedMs };
      }
    }

    const all = this.store.listResources(req.pool);
    const everMatching = all.filter((r) => matchesTags(r.tags, req.tags));
    if (everMatching.length === 0 || everMatching.every((r) => !r.enabledInConfig)) {
      throw this.noMatchingResource(req, all, everMatching);
    }

    const chosen = this.store
      .listAcquireCandidates(req.pool)
      .find((r) => matchesTags(r.tags, req.tags));
    if (!chosen) return null;

    const leaseId = this.leaseIdFactory();
    const expiresAt = now + ttlMs;
    // The partial unique index on leases(resource_id) WHERE state='ACTIVE' makes a double
    // lease a constraint violation even if the state check below were ever wrong.
    this.store.insertLease({
      id: leaseId,
      resourceId: chosen.id,
      pool: req.pool,
      owner: req.owner,
      principal: req.principal,
      clientRequestId: req.clientRequestId,
      purpose: req.purpose,
      context: req.context,
      // Freeze the resource contract for the lifetime of this lease.
      snapshot: { tags: chosen.tags, metadata: chosen.metadata, secretRefs: chosen.secretRefs },
      ttlMs,
      createdAt: now,
      expiresAt,
    });
    if (!this.store.leaseResource(chosen.id, leaseId, now)) {
      throw new TestLeaseError(
        ErrorCodes.INTERNAL_ERROR,
        `Resource "${chosen.id}" changed state during acquisition; transaction rolled back.`,
        { resourceId: chosen.id },
      );
    }
    this.store.insertEvent({
      at: now,
      type: 'LEASE_ACQUIRED',
      pool: req.pool,
      resourceId: chosen.id,
      leaseId,
      owner: req.owner,
      details: {
        ttlMs,
        expiresAt,
        waitedMs,
        principal: req.principal,
        ...(Object.keys(req.tags).length ? { tags: req.tags } : {}),
        ...(req.clientRequestId ? { clientRequestId: req.clientRequestId } : {}),
        ...(req.purpose ? { purpose: req.purpose } : {}),
      },
    });
    return { lease: toLeaseView(this.store.getLease(leaseId)!), reused: false, waitedMs };
  }

  // -------------------------------------------------------------------- renew

  renew(
    leaseId: string,
    input: RenewRequest,
    actor: Actor = { principal: LOCAL_PRINCIPAL },
  ): RenewResponse {
    const req = validate(renewRequestSchema, input, 'renew request');
    const principal = validate(principalSchema, actor.principal, 'principal');
    this.assertNotStopped();
    const now = this.clock.now();
    const touched: string[] = [];
    let view: LeaseView;
    try {
      view = this.store.transaction(() => {
        for (const e of this.expireDueInTx(now)) touched.push(e.pool);
        const lease = this.requireLease(leaseId);
        this.assertActive(lease, 'renew');
        this.assertOwnership(lease, req.owner, principal, false, 'renew');
        const pool = this.store.getPool(lease.pool);
        const ttlMs = req.ttlMs ?? lease.ttlMs;
        if (pool && ttlMs > pool.maxTtlMs) {
          throw new TestLeaseError(
            ErrorCodes.INVALID_REQUEST,
            `Requested TTL ${formatDuration(ttlMs)} exceeds the maximum TTL ${formatDuration(pool.maxTtlMs)} of pool "${lease.pool}".`,
            { pool: lease.pool, ttlMs, maxTtlMs: pool.maxTtlMs },
          );
        }
        const expiresAt = now + ttlMs;
        this.store.renewLease(lease.id, expiresAt, ttlMs, now);
        // One event per heartbeat is noise at scale; `renewCount`/`lastHeartbeatAt` live on the lease.
        if (this.recordRenewals || ttlMs !== lease.ttlMs) {
          this.store.insertEvent({
            at: now,
            type: 'LEASE_RENEWED',
            pool: lease.pool,
            resourceId: lease.resourceId,
            leaseId: lease.id,
            owner: lease.owner,
            details: {
              previousExpiresAt: lease.expiresAt,
              expiresAt,
              ttlMs,
              renewCount: lease.renewCount + 1,
            },
          });
        }
        return toLeaseView(this.store.getLease(lease.id)!);
      });
    } finally {
      this.onStateChanged(touched);
    }
    this.logger.debug(
      {
        event: 'lease.renewed',
        leaseId,
        pool: view.pool,
        resourceId: view.resourceId,
        owner: view.owner,
        expiresAt: view.expiresAt,
      },
      'lease renewed',
    );
    this.scheduleReaper();
    return { lease: view };
  }

  // ------------------------------------------------------------------ release

  /** Idempotent: releasing an already released or expired lease is a no-op with a distinct outcome. */
  release(
    leaseId: string,
    input: ReleaseRequest,
    actor: Actor = { principal: LOCAL_PRINCIPAL },
  ): ReleaseResponse {
    const req = validate(releaseRequestSchema, input, 'release request');
    const principal = validate(principalSchema, actor.principal, 'principal');
    const now = this.clock.now();
    const touched: string[] = [];
    let response: ReleaseResponse;
    try {
      response = this.store.transaction(() => {
        for (const e of this.expireDueInTx(now)) touched.push(e.pool);
        const lease = this.requireLease(leaseId);
        if (lease.state === 'RELEASED')
          return { lease: toLeaseView(lease), outcome: 'already_released' as const };
        if (lease.state === 'EXPIRED')
          return { lease: toLeaseView(lease), outcome: 'already_expired' as const };
        this.assertOwnership(lease, req.owner, principal, req.force === true, 'release');
        this.endActiveLease(lease, 'RELEASED', req.force ? 'FORCE_RELEASED' : 'RELEASED', now, {
          heldMs: now - lease.createdAt,
          by: req.owner,
          principal,
          ...(req.force ? { force: true } : {}),
        });
        touched.push(lease.pool);
        return { lease: toLeaseView(this.store.getLease(lease.id)!), outcome: 'released' as const };
      });
    } finally {
      this.onStateChanged(touched);
    }
    if (response.outcome === 'released') this.counter(response.lease.pool).released++;
    this.logger.info(
      {
        event: 'lease.released',
        leaseId,
        pool: response.lease.pool,
        resourceId: response.lease.resourceId,
        owner: response.lease.owner,
        outcome: response.outcome,
        ...(req.force ? { force: true, by: req.owner } : {}),
      },
      response.outcome === 'released' ? 'lease released' : `release ignored (${response.outcome})`,
    );
    return response;
  }

  // --------------------------------------------------------------- quarantine

  /** Ends the lease and marks its resource QUARANTINED so it is not handed out again. */
  quarantine(
    leaseId: string,
    input: QuarantineRequest,
    actor: Actor = { principal: LOCAL_PRINCIPAL },
  ): QuarantineResponse {
    const req = validate(quarantineRequestSchema, input, 'quarantine request');
    const principal = validate(principalSchema, actor.principal, 'principal');
    const now = this.clock.now();
    const touched: string[] = [];
    let response: QuarantineResponse;
    try {
      response = this.store.transaction(() => {
        for (const e of this.expireDueInTx(now)) touched.push(e.pool);
        const lease = this.requireLease(leaseId);
        this.assertActive(lease, 'quarantine');
        this.assertOwnership(lease, req.owner, principal, req.force === true, 'quarantine');
        this.store.endLease(lease.id, 'RELEASED', 'QUARANTINED', now);
        this.store.insertEvent({
          at: now,
          type: 'LEASE_RELEASED',
          pool: lease.pool,
          resourceId: lease.resourceId,
          leaseId: lease.id,
          owner: lease.owner,
          details: {
            heldMs: now - lease.createdAt,
            by: req.owner,
            principal,
            quarantined: true,
            ...(req.force ? { force: true } : {}),
          },
        });
        this.store.quarantineResource(lease.resourceId, req.reason, req.owner, now);
        this.store.insertEvent({
          at: now,
          type: 'RESOURCE_QUARANTINED',
          pool: lease.pool,
          resourceId: lease.resourceId,
          leaseId: lease.id,
          owner: req.owner,
          details: { reason: req.reason },
        });
        const resource = this.store.getResource(lease.resourceId)!;
        return {
          lease: toLeaseView(this.store.getLease(lease.id)!),
          resource: toResourceView(resource, null),
        };
      });
    } finally {
      this.onStateChanged(touched);
    }
    this.counter(response.lease.pool).quarantined++;
    this.logger.warn(
      {
        event: 'resource.quarantined',
        leaseId,
        pool: response.lease.pool,
        resourceId: response.lease.resourceId,
        owner: req.owner,
        reason: req.reason,
      },
      'resource quarantined',
    );
    return response;
  }

  /** Administrative quarantine by resource id (no lease needed). */
  quarantineResource(
    resourceId: string,
    input: QuarantineResourceRequest,
    actor: Actor = { principal: LOCAL_PRINCIPAL },
  ): { resource: ResourceView } {
    const req = validate(quarantineResourceRequestSchema, input, 'quarantine request');
    const by = validate(principalSchema, actor.principal, 'principal');
    const now = this.clock.now();
    const touched: string[] = [];
    let view: ResourceView;
    try {
      view = this.store.transaction(() => {
        for (const e of this.expireDueInTx(now)) touched.push(e.pool);
        const resource = this.requireResource(resourceId);
        if (resource.state === 'QUARANTINED') return toResourceView(resource, null);
        if (resource.state === 'LEASED') {
          const active = this.store.getActiveLeaseForResource(resource.id);
          if (!req.force) {
            throw new TestLeaseError(
              ErrorCodes.RESOURCE_LEASED,
              `Resource "${resourceId}" is currently leased${active ? ` by "${active.owner}" (lease ${active.id}, expires in ${formatDuration(active.expiresAt - now)})` : ''}. Quarantine it through its lease, or pass force to end the active lease.`,
              active
                ? {
                    resourceId,
                    leaseId: active.id,
                    owner: active.owner,
                    expiresAt: active.expiresAt,
                  }
                : { resourceId },
            );
          }
          if (active) {
            this.store.endLease(active.id, 'RELEASED', 'FORCE_RELEASED', now);
            this.store.insertEvent({
              at: now,
              type: 'LEASE_RELEASED',
              pool: active.pool,
              resourceId: active.resourceId,
              leaseId: active.id,
              owner: active.owner,
              details: { heldMs: now - active.createdAt, by, force: true, quarantined: true },
            });
          }
        }
        this.store.quarantineResource(resource.id, req.reason, by, now);
        this.store.insertEvent({
          at: now,
          type: 'RESOURCE_QUARANTINED',
          pool: resource.pool,
          resourceId: resource.id,
          owner: by,
          details: { reason: req.reason, ...(resource.state === 'LEASED' ? { force: true } : {}) },
        });
        return toResourceView(this.store.getResource(resource.id)!, null);
      });
    } finally {
      this.onStateChanged(touched);
    }
    this.logger.warn(
      { event: 'resource.quarantined', pool: view.pool, resourceId, by, reason: req.reason },
      'resource quarantined',
    );
    return { resource: view };
  }

  restoreResource(resourceId: string): RestoreResponse {
    const now = this.clock.now();
    const touched: string[] = [];
    let view: ResourceView;
    try {
      view = this.store.transaction(() => {
        const resource = this.requireResource(resourceId);
        if (resource.state !== 'QUARANTINED') {
          throw new TestLeaseError(
            ErrorCodes.RESOURCE_NOT_QUARANTINED,
            `Resource "${resourceId}" is ${resource.state}, not QUARANTINED; nothing to restore.`,
            { resourceId, state: resource.state },
          );
        }
        const next = resource.enabledInConfig ? 'AVAILABLE' : 'DISABLED';
        this.store.restoreResource(resource.id, next, now);
        this.store.insertEvent({
          at: now,
          type: 'RESOURCE_RESTORED',
          pool: resource.pool,
          resourceId: resource.id,
          details: {
            previousReason: resource.quarantineReason,
            quarantinedForMs: resource.quarantinedAt ? now - resource.quarantinedAt : null,
            state: next,
          },
        });
        touched.push(resource.pool);
        return toResourceView(this.store.getResource(resource.id)!, null);
      });
    } finally {
      this.onStateChanged(touched);
    }
    this.logger.info(
      { event: 'resource.restored', pool: view.pool, resourceId, state: view.state },
      'resource restored',
    );
    return { resource: view };
  }

  // ------------------------------------------------------------------ secrets

  /**
   * Returns the secret *references* for an active lease after checking ownership.
   * Resolution to values happens outside the engine (SecretsService) and is never logged.
   */
  secretRefsForLease(
    leaseId: string,
    ownerInput: string,
    actor: Actor = { principal: LOCAL_PRINCIPAL },
  ): { lease: LeaseView; refs: Record<string, string> } {
    const owner = validate(ownerSchema, ownerInput, 'owner');
    const principal = validate(principalSchema, actor.principal, 'principal');
    const now = this.clock.now();
    const touched: string[] = [];
    try {
      return this.store.transaction(() => {
        for (const e of this.expireDueInTx(now)) touched.push(e.pool);
        const lease = this.requireLease(leaseId);
        this.assertActive(lease, 'resolve secrets for');
        this.assertOwnership(lease, owner, principal, false, 'resolve secrets for');
        // Secret references come from the lease's frozen snapshot, not from the live resource,
        // so a rotated reference in configuration does not change a running test's credentials.
        this.store.insertEvent({
          at: now,
          type: 'LEASE_SECRETS_RESOLVED',
          pool: lease.pool,
          resourceId: lease.resourceId,
          leaseId: lease.id,
          owner,
          details: { secretKeys: Object.keys(lease.snapshot.secretRefs).sort(), principal },
        });
        return { lease: toLeaseView(lease), refs: { ...lease.snapshot.secretRefs } };
      });
    } finally {
      this.onStateChanged(touched);
    }
  }

  // ------------------------------------------------------------------- expiry

  /** Expires every overdue lease and wakes waiters. Safe to call at any time. */
  expireDue(): LeaseRow[] {
    const now = this.clock.now();
    const expired = this.store.transaction(() => this.expireDueInTx(now));
    this.onStateChanged(expired.map((l) => l.pool));
    return expired;
  }

  private expireDueInTx(now: number): LeaseRow[] {
    const due = this.store.listDueLeases(now);
    for (const lease of due) {
      this.counter(lease.pool).expired++;
      this.endActiveLease(lease, 'EXPIRED', 'EXPIRED', now, {
        expiresAt: lease.expiresAt,
        lastHeartbeatAt: lease.lastHeartbeatAt,
        overdueMs: now - lease.expiresAt,
        heldMs: now - lease.createdAt,
      });
      this.logger.warn(
        {
          event: 'lease.expired',
          leaseId: lease.id,
          pool: lease.pool,
          resourceId: lease.resourceId,
          owner: lease.owner,
          sinceHeartbeatMs: now - lease.lastHeartbeatAt,
        },
        'lease expired without release; resource reclaimed',
      );
    }
    return due;
  }

  private endActiveLease(
    lease: LeaseRow,
    state: 'RELEASED' | 'EXPIRED',
    reason: 'RELEASED' | 'EXPIRED' | 'FORCE_RELEASED',
    now: number,
    details: Record<string, unknown>,
  ): void {
    if (!this.store.endLease(lease.id, state, reason, now)) {
      throw new TestLeaseError(
        ErrorCodes.INTERNAL_ERROR,
        `Lease ${lease.id} was not ACTIVE when ending it.`,
        {
          leaseId: lease.id,
        },
      );
    }
    this.store.insertEvent({
      at: now,
      type: state === 'EXPIRED' ? 'LEASE_EXPIRED' : 'LEASE_RELEASED',
      pool: lease.pool,
      resourceId: lease.resourceId,
      leaseId: lease.id,
      owner: lease.owner,
      details,
    });
    const resource = this.store.getResource(lease.resourceId);
    if (resource && resource.state === 'LEASED' && resource.activeLeaseId === lease.id) {
      const next = resource.enabledInConfig ? 'AVAILABLE' : 'DISABLED';
      if (!this.store.freeResource(resource.id, lease.id, next, now)) {
        throw new TestLeaseError(
          ErrorCodes.INTERNAL_ERROR,
          `Resource "${resource.id}" could not be freed.`,
          {
            resourceId: resource.id,
            leaseId: lease.id,
          },
        );
      }
      if (next === 'DISABLED') {
        this.store.insertEvent({
          at: now,
          type: 'RESOURCE_DISABLED',
          pool: resource.pool,
          resourceId: resource.id,
          leaseId: lease.id,
          details: { reason: 'lease ended after the resource was removed from configuration' },
        });
      }
    }
  }

  private scheduleReaper(): void {
    if (!this.started || this.stopped) return;
    if (this.reaperTimer) {
      clearTimeout(this.reaperTimer);
      this.reaperTimer = null;
    }
    const next = this.store.nextExpiry();
    if (next === null) return;
    const delay = Math.min(Math.max(next - this.clock.now(), 1), this.reaperMaxDelayMs);
    this.reaperTimer = setTimeout(() => {
      this.reaperTimer = null;
      try {
        this.expireDue();
      } catch (err) {
        this.logger.error(
          { event: 'lease.reaper_error', error: (err as Error).message },
          'expiry sweep failed',
        );
      }
      this.scheduleReaper();
    }, delay);
    this.reaperTimer.unref();
  }

  // ----------------------------------------------------------------- waiters

  /** Re-evaluates waiters of the given pools. Re-entrancy safe; runs synchronously to completion. */
  private onStateChanged(pools: string[]): void {
    for (const p of pools) this.pendingPumps.add(p);
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.pendingPumps.size) {
        const [pool] = this.pendingPumps;
        this.pendingPumps.delete(pool!);
        this.pump(pool!);
      }
    } finally {
      this.pumping = false;
    }
  }

  private pump(pool: string): void {
    const queued = [...this.waiters.list(pool)];
    if (queued.length === 0) return;
    const now = this.clock.now();
    for (const waiter of queued) {
      const touched: string[] = [];
      let result: AcquireResponse | null;
      try {
        result = this.store.transaction(() =>
          this.acquireInTx(waiter.request, now, now - waiter.enqueuedAt, touched),
        );
      } catch (err) {
        if (this.waiters.remove(waiter)) waiter.reject(err);
        continue;
      } finally {
        for (const p of touched) this.pendingPumps.add(p);
      }
      if (result && this.waiters.remove(waiter)) {
        const c = this.counter(pool);
        if (result.reused) c.reused++;
        else {
          c.acquired++;
          c.waitMsSum += result.waitedMs;
          c.waitCount++;
        }
        this.logger.info(
          {
            event: result.reused ? 'lease.reused' : 'lease.acquired',
            pool,
            resourceId: result.lease.resourceId,
            leaseId: result.lease.leaseId,
            owner: waiter.owner,
            waitedMs: result.waitedMs,
            ttlMs: result.lease.ttlMs,
          },
          'lease acquired after waiting',
        );
        waiter.resolve(result);
      }
    }
    this.scheduleReaper();
  }

  // ----------------------------------------------------------------- helpers

  private normalizeAcquire(
    input: AcquireRequest,
    principalInput: string | undefined,
  ): NormalizedAcquire {
    const req = validate(acquireRequestSchema, input, 'acquire request');
    const principal = validate(principalSchema, principalInput ?? LOCAL_PRINCIPAL, 'principal');
    return {
      pool: req.pool,
      owner: req.owner,
      principal,
      tags: req.tags ?? {},
      ttlMs: req.ttlMs,
      waitTimeoutMs: Math.min(req.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, this.maxWaitMs),
      clientRequestId: req.clientRequestId ?? null,
      purpose: req.purpose ?? null,
      context: req.context ?? null,
    };
  }

  private poolSummary(name: string): PoolSummary {
    const pool = this.store.getPool(name)!;
    const counts = this.store.countStates(name);
    return {
      name,
      ...(pool.description ? { description: pool.description } : {}),
      defaultTtlMs: pool.defaultTtlMs,
      maxTtlMs: pool.maxTtlMs,
      counts: {
        available: counts.AVAILABLE,
        leased: counts.LEASED,
        quarantined: counts.QUARANTINED,
        disabled: counts.DISABLED,
        total: counts.AVAILABLE + counts.LEASED + counts.QUARANTINED + counts.DISABLED,
      },
      waiting: this.waiters.count(name),
    };
  }

  private requireLease(leaseId: string): LeaseRow {
    const lease = this.store.getLease(leaseId);
    if (!lease) {
      throw new TestLeaseError(ErrorCodes.LEASE_NOT_FOUND, `Lease "${leaseId}" does not exist.`, {
        leaseId,
      });
    }
    return lease;
  }

  private requireResource(resourceId: string): ResourceRow {
    const resource = this.store.getResource(resourceId);
    if (!resource) {
      throw new TestLeaseError(
        ErrorCodes.RESOURCE_NOT_FOUND,
        `Resource "${resourceId}" does not exist.`,
        {
          resourceId,
        },
      );
    }
    return resource;
  }

  private assertActive(lease: LeaseRow, action: string): void {
    if (lease.state === 'ACTIVE') return;
    const now = this.clock.now();
    if (lease.state === 'EXPIRED') {
      const successor = this.store.getActiveLeaseForResource(lease.resourceId);
      throw new TestLeaseError(
        ErrorCodes.LEASE_EXPIRED,
        `Cannot ${action} lease ${lease.id}: it expired ${formatDuration(now - lease.expiresAt)} ago (TTL ${formatDuration(lease.ttlMs)}, last heartbeat ${formatDuration(lease.expiresAt - lease.ttlMs > 0 ? now - lease.lastHeartbeatAt : now - lease.lastHeartbeatAt)} ago).${successor ? ` Resource "${lease.resourceId}" is now leased by "${successor.owner}".` : ''}`,
        {
          leaseId: lease.id,
          resourceId: lease.resourceId,
          expiresAt: lease.expiresAt,
          lastHeartbeatAt: lease.lastHeartbeatAt,
          ...(successor ? { currentLeaseId: successor.id, currentOwner: successor.owner } : {}),
        },
      );
    }
    throw new TestLeaseError(
      ErrorCodes.LEASE_NOT_ACTIVE,
      `Cannot ${action} lease ${lease.id}: it was already ${lease.endReason === 'QUARANTINED' ? 'released with quarantine' : 'released'}${lease.endedAt ? ` ${formatDuration(now - lease.endedAt)} ago` : ''}.`,
      { leaseId: lease.id, state: lease.state, endReason: lease.endReason, endedAt: lease.endedAt },
    );
  }

  /**
   * Ownership = authenticated principal AND logical owner. `force` (admin) bypasses both;
   * the server only passes force=true for callers holding `lease:admin`.
   */
  private assertOwnership(
    lease: LeaseRow,
    owner: string,
    principal: string,
    force: boolean,
    action: string,
  ): void {
    if (force) return;
    if (lease.owner !== owner) {
      throw new TestLeaseError(
        ErrorCodes.LEASE_OWNERSHIP_MISMATCH,
        `Cannot ${action} lease ${lease.id}: it is owned by "${lease.owner}", not "${owner}".`,
        { leaseId: lease.id, mismatch: 'owner', leaseOwner: lease.owner, presentedOwner: owner },
      );
    }
    if (lease.principal !== principal) {
      throw new TestLeaseError(
        ErrorCodes.LEASE_OWNERSHIP_MISMATCH,
        `Cannot ${action} lease ${lease.id}: it was acquired by principal "${lease.principal}", not "${principal}". Use the same API token, or the lease:admin scope with force.`,
        {
          leaseId: lease.id,
          mismatch: 'principal',
          leasePrincipal: lease.principal,
          presentedPrincipal: principal,
        },
      );
    }
  }

  private assertNotStopped(): void {
    if (this.stopped) {
      throw new TestLeaseError(ErrorCodes.SERVER_SHUTTING_DOWN, 'TestLease is shutting down.');
    }
  }

  private poolNotFound(name: string): TestLeaseError {
    const known = this.store
      .listPools()
      .filter((p) => p.present)
      .map((p) => p.name);
    return new TestLeaseError(
      ErrorCodes.POOL_NOT_FOUND,
      `Pool "${name}" does not exist.${known.length ? ` Known pools: ${known.join(', ')}.` : ' No pools are configured.'}`,
      { pool: name, knownPools: known },
    );
  }

  private noMatchingResource(
    req: NormalizedAcquire,
    all: ResourceRow[],
    matchingButDisabled: ResourceRow[],
  ): TestLeaseError {
    const keys = Object.keys(req.tags);
    const known = knownTagValues(all, keys);
    let message: string;
    if (matchingButDisabled.length) {
      message = `No enabled resource in pool "${req.pool}" matches the requested tags; ${matchingButDisabled.map((r) => r.id).join(', ')} match but are disabled in configuration.`;
    } else if (keys.length === 0) {
      message = `Pool "${req.pool}" has no resources.`;
    } else {
      const requested = keys.map((k) => `${k}=${req.tags[k]}`).join(', ');
      const hints = keys
        .map(
          (k) =>
            `${k}: ${known[k]?.length ? known[k]!.join(', ') : '(no resource defines this key)'}`,
        )
        .join('; ');
      message = `No resource in pool "${req.pool}" (${all.length} resource${all.length === 1 ? '' : 's'}) matches ${requested}. Known values: ${hints}.`;
    }
    return new TestLeaseError(ErrorCodes.NO_MATCHING_RESOURCE, message, {
      pool: req.pool,
      requested: req.tags,
      resourceCount: all.length,
      knownValues: known,
      ...(matchingButDisabled.length
        ? { disabledMatches: matchingButDisabled.map((r) => r.id) }
        : {}),
    });
  }

  buildDiagnostic(pool: string, tags: Tags, waitedMs: number): AcquireDiagnostic {
    const now = this.clock.now();
    const active = new Map(this.store.listActiveLeases(pool).map((l) => [l.resourceId, l]));
    const resources = this.store.listResources(pool).map((r) => {
      const lease = active.get(r.id);
      return {
        id: r.id,
        state: r.state,
        compatible: matchesTags(r.tags, tags),
        ...(lease ? { owner: lease.owner, expiresInMs: lease.expiresAt - now } : {}),
        ...(lease?.purpose ? { purpose: lease.purpose } : {}),
        ...(r.quarantineReason ? { quarantineReason: r.quarantineReason } : {}),
      };
    });
    const waiters = this.waiters.list(pool);
    const oldest = waiters.length ? Math.max(...waiters.map((w) => now - w.enqueuedAt)) : null;
    return {
      pool,
      requested: tags,
      waitedMs,
      resources,
      waiters: waiters.length,
      oldestWaiterMs: oldest,
    };
  }

  private exhaustedError(
    req: NormalizedAcquire,
    waitedMs: number,
    code: 'POOL_EXHAUSTED' | 'ACQUIRE_TIMEOUT',
  ): TestLeaseError {
    const diagnostic = this.buildDiagnostic(req.pool, req.tags, waitedMs);
    const headline =
      code === 'ACQUIRE_TIMEOUT'
        ? `No matching resource became available within ${formatDuration(req.waitTimeoutMs)}.`
        : `No matching resource is available right now in pool "${req.pool}" (waitTimeoutMs = 0).`;
    return new TestLeaseError(code, formatAcquireDiagnostic(diagnostic, headline), {
      ...diagnostic,
    });
  }

  private abortedError(req: NormalizedAcquire, waitedMs: number): TestLeaseError {
    return new TestLeaseError(
      ErrorCodes.ACQUIRE_ABORTED,
      `Acquisition in pool "${req.pool}" was cancelled by the caller after ${formatDuration(waitedMs)}.`,
      { pool: req.pool, waitedMs },
    );
  }
}
