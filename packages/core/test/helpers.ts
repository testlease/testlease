import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../src/clock.js';
import { validateConfig } from '../src/config/load.js';
import type { TestLeaseConfig } from '../src/config/schema.js';
import { EnvSecretResolver } from '../src/secrets/resolver.js';
import { createTestLease, type TestLeaseEngine } from '../src/testlease.js';
import type { Logger } from '../src/logger.js';

export const TEST_SECRETS: Record<string, string> = {
  BUYER_01_PASSWORD: 'hunter2-buyer-01',
  BUYER_02_PASSWORD: 'hunter2-buyer-02',
  BUYER_03_PASSWORD: 'hunter2-buyer-03',
  ADMIN_PASSWORD: 'admin-super-secret',
};

export function baseConfigInput(): Record<string, unknown> {
  return {
    pools: {
      buyers: {
        description: 'Premium buyer accounts',
        defaultTtl: '10m',
        maxTtl: '1h',
        resources: [
          {
            id: 'buyer-01',
            tags: { region: 'nl', paymentMethod: 'ideal' },
            metadata: { email: 'buyer01@example.test' },
            secrets: { password: 'env:BUYER_01_PASSWORD' },
          },
          {
            id: 'buyer-02',
            tags: { region: 'nl', paymentMethod: 'card' },
            metadata: { email: 'buyer02@example.test' },
            secrets: { password: 'env:BUYER_02_PASSWORD' },
          },
          {
            id: 'buyer-03',
            tags: { region: 'be', paymentMethod: 'ideal' },
            metadata: { email: 'buyer03@example.test' },
            secrets: { password: 'env:BUYER_03_PASSWORD' },
          },
        ],
      },
      admins: {
        defaultTtl: '5m',
        resources: [
          {
            id: 'admin-01',
            metadata: { email: 'admin@example.test' },
            secrets: { password: 'env:ADMIN_PASSWORD' },
          },
        ],
      },
    },
  };
}

export function config(input: unknown = baseConfigInput()): TestLeaseConfig {
  return validateConfig(input, '<test>').config;
}

export interface EngineOptions {
  configInput?: unknown;
  clock?: Clock;
  dbPath?: string;
  logger?: Logger;
  secrets?: Record<string, string>;
  maxWaitMs?: number;
}

export async function makeEngine(options: EngineOptions = {}): Promise<TestLeaseEngine> {
  const cfg = config(options.configInput ?? baseConfigInput());
  if (options.maxWaitMs !== undefined) cfg.server.maxWait = options.maxWaitMs;
  return createTestLease({
    config: cfg,
    dbPath: options.dbPath ?? ':memory:',
    clock: options.clock,
    logger: options.logger,
    secretResolvers: [new EnvSecretResolver(options.secrets ?? TEST_SECRETS)],
    version: 'test',
  });
}

export function tempDir(prefix = 'testlease-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Polls until `fn` returns truthy or the timeout elapses. */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  timeoutMs = 5_000,
  intervalMs = 10,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}

export async function expectError<T = unknown>(p: Promise<unknown> | (() => unknown)): Promise<T> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    return err as T;
  }
  throw new Error('expected an error to be thrown');
}

/**
 * Invariant check from the event log: for every resource, LEASE_ACQUIRED events must alternate
 * with LEASE_RELEASED/LEASE_EXPIRED events in `seq` order. Two acquisitions without an end in
 * between would mean two owners existed at once.
 */
export function assertNoOverlappingLeases(
  events: { seq: number; type: string; resourceId?: string; leaseId?: string }[],
): {
  perResource: Record<string, number>;
} {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const active = new Map<string, string>();
  const perResource: Record<string, number> = {};
  for (const e of sorted) {
    if (!e.resourceId) continue;
    if (e.type === 'LEASE_ACQUIRED') {
      const current = active.get(e.resourceId);
      if (current) {
        throw new Error(
          `overlap: resource ${e.resourceId} acquired by lease ${e.leaseId} (seq ${e.seq}) while lease ${current} was still active`,
        );
      }
      active.set(e.resourceId, e.leaseId!);
      perResource[e.resourceId] = (perResource[e.resourceId] ?? 0) + 1;
    } else if (e.type === 'LEASE_RELEASED' || e.type === 'LEASE_EXPIRED') {
      const current = active.get(e.resourceId);
      if (current !== e.leaseId) {
        throw new Error(
          `resource ${e.resourceId}: ${e.type} for lease ${e.leaseId} (seq ${e.seq}) but active lease was ${current ?? 'none'}`,
        );
      }
      active.delete(e.resourceId);
    }
  }
  return { perResource };
}
