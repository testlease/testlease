import type {
  LeaseEndReason,
  LeaseState,
  Metadata,
  ResourceState,
  Tags,
} from '@testlease/protocol';
import type { SqliteDatabase } from '../db/database.js';
import type { EventRow, LeaseRow, PoolRow, ResourceRow, ResourceSnapshot } from './rows.js';

/* Raw row shapes as returned by better-sqlite3 (snake_case). */
interface RawPool {
  name: string;
  description: string | null;
  default_ttl_ms: number;
  max_ttl_ms: number;
  present: number;
  created_at: number;
  updated_at: number;
}
interface RawResource {
  id: string;
  pool: string;
  state: ResourceState;
  enabled_in_config: number;
  tags_json: string;
  metadata_json: string;
  secret_refs_json: string;
  active_lease_id: string | null;
  quarantine_reason: string | null;
  quarantined_at: number | null;
  quarantined_by: string | null;
  last_leased_at: number | null;
  created_at: number;
  updated_at: number;
}
interface RawLease {
  id: string;
  resource_id: string;
  pool: string;
  owner: string;
  principal: string;
  state: LeaseState;
  client_request_id: string | null;
  purpose: string | null;
  context_json: string | null;
  resource_snapshot_json: string;
  ttl_ms: number;
  created_at: number;
  expires_at: number;
  last_heartbeat_at: number;
  ended_at: number | null;
  end_reason: LeaseEndReason | null;
}
interface RawEvent {
  seq: number;
  at: number;
  type: string;
  pool: string | null;
  resource_id: string | null;
  lease_id: string | null;
  owner: string | null;
  details_json: string | null;
}

const mapPool = (r: RawPool): PoolRow => ({
  name: r.name,
  description: r.description,
  defaultTtlMs: r.default_ttl_ms,
  maxTtlMs: r.max_ttl_ms,
  present: r.present === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapResource = (r: RawResource): ResourceRow => ({
  id: r.id,
  pool: r.pool,
  state: r.state,
  enabledInConfig: r.enabled_in_config === 1,
  tags: JSON.parse(r.tags_json) as Tags,
  metadata: JSON.parse(r.metadata_json) as Metadata,
  secretRefs: JSON.parse(r.secret_refs_json) as Record<string, string>,
  activeLeaseId: r.active_lease_id,
  quarantineReason: r.quarantine_reason,
  quarantinedAt: r.quarantined_at,
  quarantinedBy: r.quarantined_by,
  lastLeasedAt: r.last_leased_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapLease = (r: RawLease): LeaseRow => ({
  id: r.id,
  resourceId: r.resource_id,
  pool: r.pool,
  owner: r.owner,
  principal: r.principal,
  state: r.state,
  clientRequestId: r.client_request_id,
  purpose: r.purpose,
  context: r.context_json ? (JSON.parse(r.context_json) as Record<string, string>) : null,
  snapshot: JSON.parse(r.resource_snapshot_json) as ResourceSnapshot,
  ttlMs: r.ttl_ms,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastHeartbeatAt: r.last_heartbeat_at,
  endedAt: r.ended_at,
  endReason: r.end_reason,
});

const mapEvent = (r: RawEvent): EventRow => ({
  seq: r.seq,
  at: r.at,
  type: r.type,
  pool: r.pool,
  resourceId: r.resource_id,
  leaseId: r.lease_id,
  owner: r.owner,
  details: r.details_json ? (JSON.parse(r.details_json) as Record<string, unknown>) : null,
});

export interface InsertLeaseInput {
  id: string;
  resourceId: string;
  pool: string;
  owner: string;
  principal: string;
  clientRequestId: string | null;
  purpose: string | null;
  context: Record<string, string> | null;
  snapshot: ResourceSnapshot;
  ttlMs: number;
  createdAt: number;
  expiresAt: number;
}

export interface InsertEventInput {
  at: number;
  type: string;
  pool?: string | null;
  resourceId?: string | null;
  leaseId?: string | null;
  owner?: string | null;
  details?: Record<string, unknown> | null;
}

export interface PoolStateCounts {
  AVAILABLE: number;
  LEASED: number;
  QUARANTINED: number;
  DISABLED: number;
}

export interface IntegrityProblem {
  kind:
    | 'LEASED_WITHOUT_ACTIVE_LEASE'
    | 'ACTIVE_LEASE_WITHOUT_LEASED_RESOURCE'
    | 'MULTIPLE_ACTIVE_LEASES';
  resourceId: string;
  leaseId?: string;
}

/**
 * All SQL lives here. Every method is synchronous; callers group writes with `transaction()`
 * (BEGIN IMMEDIATE) so that a whole acquire/release is one atomic unit even across processes.
 */
export class SqliteStore {
  readonly db: SqliteDatabase;
  private readonly stmts;

  constructor(db: SqliteDatabase) {
    this.db = db;
    this.stmts = {
      getPool: db.prepare(`SELECT * FROM pools WHERE name = ?`),
      listPools: db.prepare(`SELECT * FROM pools ORDER BY name`),
      upsertPool: db.prepare(`
        INSERT INTO pools (name, description, default_ttl_ms, max_ttl_ms, present, created_at, updated_at)
        VALUES (@name, @description, @defaultTtlMs, @maxTtlMs, 1, @now, @now)
        ON CONFLICT(name) DO UPDATE SET
          description = excluded.description,
          default_ttl_ms = excluded.default_ttl_ms,
          max_ttl_ms = excluded.max_ttl_ms,
          present = 1,
          updated_at = excluded.updated_at`),
      markPoolAbsent: db.prepare(`UPDATE pools SET present = 0, updated_at = ? WHERE name = ?`),

      getResource: db.prepare(`SELECT * FROM resources WHERE id = ?`),
      listResources: db.prepare(`SELECT * FROM resources ORDER BY pool, id`),
      listResourcesInPool: db.prepare(`SELECT * FROM resources WHERE pool = ? ORDER BY id`),
      listAcquireCandidates: db.prepare(`
        SELECT * FROM resources
        WHERE pool = ? AND state = 'AVAILABLE' AND enabled_in_config = 1
        ORDER BY last_leased_at IS NOT NULL, last_leased_at ASC, id ASC`),
      countStates: db.prepare(
        `SELECT state, COUNT(*) AS n FROM resources WHERE pool = ? GROUP BY state`,
      ),
      insertResource: db.prepare(`
        INSERT INTO resources (id, pool, state, enabled_in_config, tags_json, metadata_json, secret_refs_json, created_at, updated_at)
        VALUES (@id, @pool, @state, @enabledInConfig, @tagsJson, @metadataJson, @secretRefsJson, @now, @now)`),
      updateResourceConfig: db.prepare(`
        UPDATE resources SET pool = @pool, enabled_in_config = @enabledInConfig, tags_json = @tagsJson,
          metadata_json = @metadataJson, secret_refs_json = @secretRefsJson, updated_at = @now
        WHERE id = @id`),
      setResourceState: db.prepare(
        `UPDATE resources SET state = @state, updated_at = @now WHERE id = @id`,
      ),
      leaseResource: db.prepare(`
        UPDATE resources SET state = 'LEASED', active_lease_id = @leaseId, last_leased_at = @now, updated_at = @now
        WHERE id = @id AND state = 'AVAILABLE' AND enabled_in_config = 1`),
      freeResource: db.prepare(`
        UPDATE resources SET state = @state, active_lease_id = NULL, updated_at = @now
        WHERE id = @id AND state = 'LEASED' AND active_lease_id = @leaseId`),
      quarantineResource: db.prepare(`
        UPDATE resources SET state = 'QUARANTINED', active_lease_id = NULL, quarantine_reason = @reason,
          quarantined_at = @now, quarantined_by = @by, updated_at = @now
        WHERE id = @id`),
      restoreResource: db.prepare(`
        UPDATE resources SET state = @state, quarantine_reason = NULL, quarantined_at = NULL,
          quarantined_by = NULL, updated_at = @now
        WHERE id = @id AND state = 'QUARANTINED'`),

      getLease: db.prepare(`SELECT * FROM leases WHERE id = ?`),
      getActiveLeaseForResource: db.prepare(
        `SELECT * FROM leases WHERE resource_id = ? AND state = 'ACTIVE'`,
      ),
      listActiveLeasesInPool: db.prepare(
        `SELECT * FROM leases WHERE pool = ? AND state = 'ACTIVE'`,
      ),
      listActiveLeases: db.prepare(
        `SELECT * FROM leases WHERE state = 'ACTIVE' ORDER BY expires_at`,
      ),
      findActiveByClientRequestId: db.prepare(
        `SELECT * FROM leases WHERE client_request_id = ? AND state = 'ACTIVE'`,
      ),
      listDueLeases: db.prepare(
        `SELECT * FROM leases WHERE state = 'ACTIVE' AND expires_at <= ? ORDER BY expires_at`,
      ),
      nextExpiry: db.prepare(`SELECT MIN(expires_at) AS next FROM leases WHERE state = 'ACTIVE'`),
      insertLease: db.prepare(`
        INSERT INTO leases (id, resource_id, pool, owner, principal, state, client_request_id, purpose, context_json,
          resource_snapshot_json, ttl_ms, created_at, expires_at, last_heartbeat_at)
        VALUES (@id, @resourceId, @pool, @owner, @principal, 'ACTIVE', @clientRequestId, @purpose, @contextJson,
          @snapshotJson, @ttlMs, @createdAt, @expiresAt, @createdAt)`),
      renewLease: db.prepare(`
        UPDATE leases SET expires_at = @expiresAt, last_heartbeat_at = @now, ttl_ms = @ttlMs
        WHERE id = @id AND state = 'ACTIVE'`),
      endLease: db.prepare(`
        UPDATE leases SET state = @state, ended_at = @now, end_reason = @reason
        WHERE id = @id AND state = 'ACTIVE'`),
      listLeasesForResource: db.prepare(
        `SELECT * FROM leases WHERE resource_id = ? ORDER BY created_at DESC LIMIT ?`,
      ),

      insertEvent: db.prepare(`
        INSERT INTO lease_events (at, type, pool, resource_id, lease_id, owner, details_json)
        VALUES (@at, @type, @pool, @resourceId, @leaseId, @owner, @detailsJson)`),
      eventsByLease: db.prepare(`SELECT * FROM lease_events WHERE lease_id = ? ORDER BY seq`),
      eventsByResource: db.prepare(
        `SELECT * FROM lease_events WHERE resource_id = ? ORDER BY seq DESC LIMIT ?`,
      ),
      recentEvents: db.prepare(`SELECT * FROM lease_events ORDER BY seq DESC LIMIT ?`),

      integrityLeasedWithoutLease: db.prepare(`
        SELECT r.id AS resource_id, r.active_lease_id AS lease_id FROM resources r
        LEFT JOIN leases l ON l.id = r.active_lease_id AND l.state = 'ACTIVE'
        WHERE r.state = 'LEASED' AND l.id IS NULL`),
      integrityActiveWithoutLeased: db.prepare(`
        SELECT l.resource_id AS resource_id, l.id AS lease_id FROM leases l
        JOIN resources r ON r.id = l.resource_id
        WHERE l.state = 'ACTIVE' AND (r.state <> 'LEASED' OR r.active_lease_id <> l.id)`),
      integrityMultipleActive: db.prepare(`
        SELECT resource_id, COUNT(*) AS n FROM leases WHERE state = 'ACTIVE'
        GROUP BY resource_id HAVING n > 1`),
    };
  }

  /** Runs `fn` inside BEGIN IMMEDIATE ... COMMIT. Nested calls become savepoints. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  // ---- pools -------------------------------------------------------------

  getPool(name: string): PoolRow | undefined {
    const row = this.stmts.getPool.get(name) as RawPool | undefined;
    return row ? mapPool(row) : undefined;
  }

  listPools(): PoolRow[] {
    return (this.stmts.listPools.all() as RawPool[]).map(mapPool);
  }

  upsertPool(
    input: { name: string; description: string | null; defaultTtlMs: number; maxTtlMs: number },
    now: number,
  ): void {
    this.stmts.upsertPool.run({ ...input, now });
  }

  markPoolAbsent(name: string, now: number): void {
    this.stmts.markPoolAbsent.run(now, name);
  }

  // ---- resources ---------------------------------------------------------

  getResource(id: string): ResourceRow | undefined {
    const row = this.stmts.getResource.get(id) as RawResource | undefined;
    return row ? mapResource(row) : undefined;
  }

  listResources(pool?: string): ResourceRow[] {
    const rows = (
      pool ? this.stmts.listResourcesInPool.all(pool) : this.stmts.listResources.all()
    ) as RawResource[];
    return rows.map(mapResource);
  }

  /** AVAILABLE + enabled resources, least recently leased first, then by id. */
  listAcquireCandidates(pool: string): ResourceRow[] {
    return (this.stmts.listAcquireCandidates.all(pool) as RawResource[]).map(mapResource);
  }

  countStates(pool: string): PoolStateCounts {
    const counts: PoolStateCounts = { AVAILABLE: 0, LEASED: 0, QUARANTINED: 0, DISABLED: 0 };
    for (const row of this.stmts.countStates.all(pool) as { state: ResourceState; n: number }[]) {
      counts[row.state] = row.n;
    }
    return counts;
  }

  insertResource(
    input: {
      id: string;
      pool: string;
      state: ResourceState;
      enabledInConfig: boolean;
      tags: Tags;
      metadata: Metadata;
      secretRefs: Record<string, string>;
    },
    now: number,
  ): void {
    this.stmts.insertResource.run({
      id: input.id,
      pool: input.pool,
      state: input.state,
      enabledInConfig: input.enabledInConfig ? 1 : 0,
      tagsJson: JSON.stringify(input.tags),
      metadataJson: JSON.stringify(input.metadata),
      secretRefsJson: JSON.stringify(input.secretRefs),
      now,
    });
  }

  updateResourceConfig(
    input: {
      id: string;
      pool: string;
      enabledInConfig: boolean;
      tags: Tags;
      metadata: Metadata;
      secretRefs: Record<string, string>;
    },
    now: number,
  ): void {
    this.stmts.updateResourceConfig.run({
      id: input.id,
      pool: input.pool,
      enabledInConfig: input.enabledInConfig ? 1 : 0,
      tagsJson: JSON.stringify(input.tags),
      metadataJson: JSON.stringify(input.metadata),
      secretRefsJson: JSON.stringify(input.secretRefs),
      now,
    });
  }

  setResourceState(id: string, state: 'AVAILABLE' | 'DISABLED', now: number): void {
    this.stmts.setResourceState.run({ id, state, now });
  }

  /** Returns true when the row transitioned AVAILABLE -> LEASED (exactly one row changed). */
  leaseResource(id: string, leaseId: string, now: number): boolean {
    return this.stmts.leaseResource.run({ id, leaseId, now }).changes === 1;
  }

  /** LEASED -> AVAILABLE/DISABLED, only if `leaseId` is still the active lease. */
  freeResource(id: string, leaseId: string, state: 'AVAILABLE' | 'DISABLED', now: number): boolean {
    return this.stmts.freeResource.run({ id, leaseId, state, now }).changes === 1;
  }

  quarantineResource(id: string, reason: string, by: string | null, now: number): void {
    this.stmts.quarantineResource.run({ id, reason, by, now });
  }

  restoreResource(id: string, state: 'AVAILABLE' | 'DISABLED', now: number): boolean {
    return this.stmts.restoreResource.run({ id, state, now }).changes === 1;
  }

  // ---- leases ------------------------------------------------------------

  getLease(id: string): LeaseRow | undefined {
    const row = this.stmts.getLease.get(id) as RawLease | undefined;
    return row ? mapLease(row) : undefined;
  }

  getActiveLeaseForResource(resourceId: string): LeaseRow | undefined {
    const row = this.stmts.getActiveLeaseForResource.get(resourceId) as RawLease | undefined;
    return row ? mapLease(row) : undefined;
  }

  listActiveLeases(pool?: string): LeaseRow[] {
    const rows = (
      pool ? this.stmts.listActiveLeasesInPool.all(pool) : this.stmts.listActiveLeases.all()
    ) as RawLease[];
    return rows.map(mapLease);
  }

  findActiveLeaseByClientRequestId(clientRequestId: string): LeaseRow | undefined {
    const row = this.stmts.findActiveByClientRequestId.get(clientRequestId) as RawLease | undefined;
    return row ? mapLease(row) : undefined;
  }

  listDueLeases(now: number): LeaseRow[] {
    return (this.stmts.listDueLeases.all(now) as RawLease[]).map(mapLease);
  }

  nextExpiry(): number | null {
    const row = this.stmts.nextExpiry.get() as { next: number | null };
    return row.next;
  }

  insertLease(input: InsertLeaseInput): void {
    const { context, snapshot, ...rest } = input;
    this.stmts.insertLease.run({
      ...rest,
      contextJson: context ? JSON.stringify(context) : null,
      snapshotJson: JSON.stringify(snapshot),
    });
  }

  renewLease(id: string, expiresAt: number, ttlMs: number, now: number): boolean {
    return this.stmts.renewLease.run({ id, expiresAt, ttlMs, now }).changes === 1;
  }

  endLease(
    id: string,
    state: 'RELEASED' | 'EXPIRED',
    reason: LeaseEndReason,
    now: number,
  ): boolean {
    return this.stmts.endLease.run({ id, state, reason, now }).changes === 1;
  }

  listLeasesForResource(resourceId: string, limit = 50): LeaseRow[] {
    return (this.stmts.listLeasesForResource.all(resourceId, limit) as RawLease[]).map(mapLease);
  }

  // ---- events ------------------------------------------------------------

  insertEvent(input: InsertEventInput): void {
    this.stmts.insertEvent.run({
      at: input.at,
      type: input.type,
      pool: input.pool ?? null,
      resourceId: input.resourceId ?? null,
      leaseId: input.leaseId ?? null,
      owner: input.owner ?? null,
      detailsJson: input.details ? JSON.stringify(input.details) : null,
    });
  }

  eventsByLease(leaseId: string): EventRow[] {
    return (this.stmts.eventsByLease.all(leaseId) as RawEvent[]).map(mapEvent);
  }

  eventsByResource(resourceId: string, limit = 200): EventRow[] {
    return (this.stmts.eventsByResource.all(resourceId, limit) as RawEvent[])
      .map(mapEvent)
      .reverse();
  }

  recentEvents(limit = 100): EventRow[] {
    return (this.stmts.recentEvents.all(limit) as RawEvent[]).map(mapEvent).reverse();
  }

  // ---- integrity ---------------------------------------------------------

  /** Cross-checks the denormalised resource state against the lease table. Empty = consistent. */
  checkIntegrity(): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];
    for (const r of this.stmts.integrityLeasedWithoutLease.all() as {
      resource_id: string;
      lease_id: string | null;
    }[]) {
      problems.push({
        kind: 'LEASED_WITHOUT_ACTIVE_LEASE',
        resourceId: r.resource_id,
        leaseId: r.lease_id ?? undefined,
      });
    }
    for (const r of this.stmts.integrityActiveWithoutLeased.all() as {
      resource_id: string;
      lease_id: string;
    }[]) {
      problems.push({
        kind: 'ACTIVE_LEASE_WITHOUT_LEASED_RESOURCE',
        resourceId: r.resource_id,
        leaseId: r.lease_id,
      });
    }
    for (const r of this.stmts.integrityMultipleActive.all() as {
      resource_id: string;
      n: number;
    }[]) {
      problems.push({ kind: 'MULTIPLE_ACTIVE_LEASES', resourceId: r.resource_id });
    }
    return problems;
  }
}
