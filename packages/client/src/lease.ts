import {
  isTestLeaseError,
  type LeaseResourceSnapshot,
  type LeaseView,
  type QuarantineResponse,
  type ReleaseResponse,
  type TestLeaseError,
} from '@testlease/protocol';
import type { TestLeaseClient } from './client.js';

export interface HeartbeatOptions {
  /** Defaults to a third of the TTL, clamped to [1s, 60s]. */
  intervalMs?: number;
  onError?: (err: Error, lease: Lease) => void;
}

export interface HeartbeatStatus {
  running: boolean;
  /** False after any renew failure until the next success (or permanently once the lease ended). */
  healthy: boolean;
  renewals: number;
  failures: number;
  lastRenewedAt?: number;
  lastError?: { code?: string; message: string; at: number };
}

/** Sanitized summary suitable for test reports. Contains no secrets and no secret references. */
export interface LeaseEvidence {
  leaseId: string;
  pool: string;
  resourceId: string;
  owner: string;
  principal: string;
  tags: Record<string, string>;
  acquiredAt: string;
  expiresAt: string;
  releasedAt?: string;
  /** Final known lease state as observed by this client. */
  state: LeaseView['state'];
  endReason?: LeaseView['endReason'];
  /** True if the server reported the lease expired while this handle still considered it active. */
  expiredDuringUse: boolean;
  heartbeat: HeartbeatStatus;
  /** Set when the resource was quarantined through this handle. */
  quarantineReason?: string;
}

/** Shared by the client and adapters: a clear error instead of `undefined` for a missing secret. */
export function requireSecret(secrets: Record<string, string>, name: string, known: string[], resourceId: string): string {
  const value = secrets[name];
  if (value === undefined) {
    throw new Error(
      `Resource "${resourceId}" has no secret named "${name}". Available: ${known.length ? known.join(', ') : 'none'}.`,
    );
  }
  return value;
}

const TERMINAL_CODES = new Set([
  'LEASE_EXPIRED',
  'LEASE_NOT_ACTIVE',
  'LEASE_NOT_FOUND',
  'LEASE_OWNERSHIP_MISMATCH',
]);

/**
 * A live handle to one lease. Renews automatically while `startHeartbeat()` is active, and
 * stops on release/quarantine. Timers are `unref()`ed so a forgotten handle never keeps a
 * process alive; the server-side TTL is the real safety net.
 */
export class Lease {
  private readonly client: TestLeaseClient;
  private current: LeaseView;
  private timer: NodeJS.Timeout | null = null;
  private renewInFlight: Promise<void> | null = null;
  private readonly status: HeartbeatStatus = {
    running: false,
    healthy: true,
    renewals: 0,
    failures: 0,
  };
  private expiredDuringUse = false;
  private quarantineReason: string | undefined;

  constructor(client: TestLeaseClient, view: LeaseView) {
    this.client = client;
    this.current = view;
  }

  get leaseId(): string {
    return this.current.leaseId;
  }
  get resourceId(): string {
    return this.current.resourceId;
  }
  get pool(): string {
    return this.current.pool;
  }
  get owner(): string {
    return this.current.owner;
  }
  /** Frozen resource contract: tags, metadata and secret *names*. */
  get resource(): LeaseResourceSnapshot {
    return this.current.resource;
  }
  get metadata(): LeaseResourceSnapshot['metadata'] {
    return this.current.resource.metadata;
  }
  get tags(): LeaseResourceSnapshot['tags'] {
    return this.current.resource.tags;
  }
  get expiresAt(): number {
    return this.current.expiresAt;
  }
  get state(): LeaseView['state'] {
    return this.current.state;
  }
  /** Latest lease view known to this handle. */
  get view(): LeaseView {
    return this.current;
  }
  get heartbeat(): Readonly<HeartbeatStatus> {
    return this.status;
  }

  startHeartbeat(options: HeartbeatOptions = {}): this {
    if (this.timer || this.current.state !== 'ACTIVE') return this;
    const interval =
      options.intervalMs ?? Math.min(Math.max(Math.floor(this.current.ttlMs / 3), 1_000), 60_000);
    this.status.running = true;
    this.timer = setInterval(() => {
      void this.heartbeatTick(options);
    }, interval);
    this.timer.unref();
    return this;
  }

  stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status.running = false;
  }

  private async heartbeatTick(options: HeartbeatOptions): Promise<void> {
    if (this.renewInFlight) return; // never overlap renewals
    this.renewInFlight = (async () => {
      try {
        await this.renew();
      } catch (err) {
        const e = err as Error;
        options.onError?.(e, this);
        if (isTestLeaseError(e) && TERMINAL_CODES.has((e as TestLeaseError).code))
          this.stopHeartbeat();
      } finally {
        this.renewInFlight = null;
      }
    })();
    await this.renewInFlight;
  }

  /** Renews now. Throws LEASE_EXPIRED / LEASE_NOT_ACTIVE when the lease is gone. */
  async renew(ttlMs?: number): Promise<LeaseView> {
    try {
      const res = await this.client.renew(this.leaseId, {
        owner: this.owner,
        ...(ttlMs ? { ttlMs } : {}),
      });
      this.current = res.lease;
      this.status.renewals++;
      this.status.healthy = true;
      this.status.lastRenewedAt = Date.now();
      return res.lease;
    } catch (err) {
      this.recordFailure(err);
      throw err;
    }
  }

  /** Refreshes the view from the server without renewing. */
  async refresh(): Promise<LeaseView> {
    const view = await this.client.getLease(this.leaseId);
    if (view.state === 'EXPIRED' && this.current.state === 'ACTIVE') this.expiredDuringUse = true;
    this.current = view;
    if (view.state !== 'ACTIVE') this.stopHeartbeat();
    return view;
  }

  /** Idempotent. Stops the heartbeat first so no renew races the release. */
  async release(): Promise<ReleaseResponse> {
    this.stopHeartbeat();
    if (this.renewInFlight) await this.renewInFlight.catch(() => undefined);
    const res = await this.client.release(this.leaseId, { owner: this.owner });
    if (res.outcome === 'already_expired') this.expiredDuringUse = true;
    this.current = res.lease;
    return res;
  }

  /** Ends the lease and marks the resource unusable for other tests until an operator restores it. */
  async quarantine(reason: string): Promise<QuarantineResponse> {
    this.stopHeartbeat();
    if (this.renewInFlight) await this.renewInFlight.catch(() => undefined);
    const res = await this.client.quarantine(this.leaseId, { owner: this.owner, reason });
    this.current = res.lease;
    this.quarantineReason = reason;
    return res;
  }

  /**
   * Resolves the lease's secrets. Requires a token with `secrets:resolve`. Values are returned
   * to the caller only; do not log them and do not attach them to reports.
   */
  async secrets(): Promise<Record<string, string>> {
    const res = await this.client.resolveSecrets(this.leaseId, { owner: this.owner });
    return res.secrets;
  }

  /** Resolves one secret by name, failing loudly when the resource does not define it. */
  async secret(name: string): Promise<string> {
    const all = await this.secrets();
    return requireSecret(all, name, this.current.resource.secretKeys, this.resourceId);
  }

  evidence(): LeaseEvidence {
    const v = this.current;
    return {
      leaseId: v.leaseId,
      pool: v.pool,
      resourceId: v.resourceId,
      owner: v.owner,
      principal: v.principal,
      tags: v.resource.tags,
      acquiredAt: new Date(v.createdAt).toISOString(),
      expiresAt: new Date(v.expiresAt).toISOString(),
      ...(v.endedAt ? { releasedAt: new Date(v.endedAt).toISOString() } : {}),
      state: v.state,
      ...(v.endReason ? { endReason: v.endReason } : {}),
      expiredDuringUse: this.expiredDuringUse || v.state === 'EXPIRED',
      heartbeat: { ...this.status },
      ...(this.quarantineReason ? { quarantineReason: this.quarantineReason } : {}),
    };
  }

  private recordFailure(err: unknown): void {
    this.status.failures++;
    this.status.healthy = false;
    const e = err as Error & { code?: string };
    this.status.lastError = {
      ...(e.code ? { code: e.code } : {}),
      message: e.message,
      at: Date.now(),
    };
    if (e.code === 'LEASE_EXPIRED') {
      this.expiredDuringUse = true;
      this.current = { ...this.current, state: 'EXPIRED', endReason: 'EXPIRED' };
    }
  }
}
