import type { Metadata, Tags } from '@testlease/protocol';
import type { Lease, LeaseEvidence, TestLeaseClient } from '@testlease/client';

export type LeaseScope = 'worker' | 'test';

export interface LeaseFixtureConfig {
  pool: string;
  /** `worker` (default): one lease per Playwright worker. `test`: one lease per test. */
  scope?: LeaseScope;
  tags?: Tags;
  ttlMs?: number;
  /** Overrides the adapter-wide default (60s). */
  waitTimeoutMs?: number;
  /**
   * Resolve secrets into `resource.secrets` (default true). Requires a token with
   * `secrets:resolve`; set to false for tests that only need metadata.
   */
  secrets?: boolean;
  purpose?: string;
}

/** Sanitized per-lease evidence attached to each test as `testlease.json`. */
export interface FixtureEvidence extends LeaseEvidence {
  fixture: string;
  scope: LeaseScope;
  /** True when this worker took over an existing lease (same run/project/slot after a worker restart). */
  tookOver: boolean;
  /** True when the fixture had to acquire a new resource because the previous one ended (quarantine/expiry). */
  reacquired: boolean;
  ownerParts: { runId: string; project: string; worker: string; test?: string };
  secretsResolved: boolean;
  waitedMs: number;
}

export interface ResolveResult {
  lease: Lease;
  reused: boolean;
  waitedMs: number;
}

/**
 * The value tests receive. It stays the same object for the lifetime of a worker fixture even
 * when the underlying lease is replaced (after a quarantine), so tests can hold on to it.
 */
export class LeasedResource {
  readonly fixture: string;
  readonly scope: LeaseScope;
  readonly ownerParts: FixtureEvidence['ownerParts'];
  private current: Lease;
  private currentSecrets: Record<string, string>;
  private secretsResolved: boolean;
  private tookOver: boolean;
  private reacquired = false;
  private waitedMs: number;
  private quarantineReason: string | undefined;
  private readonly client: TestLeaseClient;

  constructor(args: {
    fixture: string;
    scope: LeaseScope;
    ownerParts: FixtureEvidence['ownerParts'];
    client: TestLeaseClient;
    lease: Lease;
    secrets: Record<string, string>;
    secretsResolved: boolean;
    reused: boolean;
    waitedMs: number;
  }) {
    this.fixture = args.fixture;
    this.scope = args.scope;
    this.ownerParts = args.ownerParts;
    this.client = args.client;
    this.current = args.lease;
    this.currentSecrets = args.secrets;
    this.secretsResolved = args.secretsResolved;
    this.tookOver = args.reused;
    this.waitedMs = args.waitedMs;
  }

  get lease(): Lease {
    return this.current;
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
  get tags(): Tags {
    return this.current.resource.tags;
  }
  get metadata(): Metadata {
    return this.current.resource.metadata;
  }
  /** Resolved secret values (empty when `secrets: false`). Never attach these to reports. */
  get secrets(): Record<string, string> {
    return this.currentSecrets;
  }
  /** True when the lease is no longer usable (quarantined, released or expired). */
  get ended(): boolean {
    return this.current.state !== 'ACTIVE';
  }

  async renew(): Promise<void> {
    await this.current.renew();
  }

  /**
   * The test discovered the resource is contaminated (locked account, corrupted state, ...).
   * Ends the lease and quarantines the resource; a worker-scoped fixture acquires a
   * replacement before the next test.
   */
  async quarantine(reason: string): Promise<void> {
    await this.current.quarantine(reason);
    this.quarantineReason = reason;
  }

  /** Swaps in a replacement lease (worker scope, after the previous lease ended). */
  replace(result: ResolveResult, secrets: Record<string, string>, secretsResolved: boolean): void {
    this.current = result.lease;
    this.currentSecrets = secrets;
    this.secretsResolved = secretsResolved;
    this.tookOver = result.reused;
    this.reacquired = true;
    this.waitedMs = result.waitedMs;
    this.quarantineReason = undefined;
  }

  /** Refreshes the lease view from the server (detects expiry) and returns evidence. */
  async collectEvidence(refresh = true): Promise<FixtureEvidence> {
    if (refresh) {
      try {
        await this.current.refresh();
      } catch {
        // Keep the last known view; evidence records heartbeat health separately.
      }
    }
    const base = this.current.evidence();
    return {
      ...base,
      ...(this.quarantineReason ? { quarantineReason: this.quarantineReason } : {}),
      fixture: this.fixture,
      scope: this.scope,
      tookOver: this.tookOver,
      reacquired: this.reacquired,
      ownerParts: this.ownerParts,
      secretsResolved: this.secretsResolved,
      waitedMs: this.waitedMs,
    };
  }

  async release(): Promise<void> {
    if (this.current.state !== 'ACTIVE') {
      this.current.stopHeartbeat();
      return;
    }
    await this.current.release();
  }

  /** @internal */
  get clientRef(): TestLeaseClient {
    return this.client;
  }
}
