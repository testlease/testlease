import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTestLease,
  EnvSecretResolver,
  noopLogger,
  validateConfig,
  type Logger,
  type TestLeaseEngine,
} from '@testlease/core';
import { TestLeaseClient } from '@testlease/client';
import { startServer, type RunningServer } from '../src/index.js';

export const SECRETS: Record<string, string> = {
  BUYER_01_PASSWORD: 'hunter2-buyer-01',
  BUYER_02_PASSWORD: 'hunter2-buyer-02',
  BUYER_03_PASSWORD: 'hunter2-buyer-03',
  TOKEN_CI: 'ci-token-value-0123456789abcdef',
  TOKEN_ADMIN: 'admin-token-value-0123456789abcdef',
  TOKEN_READER: 'reader-token-value-0123456789abcdef',
};

export function buyersConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server: { host: '127.0.0.1', port: 0, db: ':memory:', maxWait: '30s', logLevel: 'silent' },
    pools: {
      buyers: {
        defaultTtl: '10m',
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
    },
    ...extra,
  };
}

export const TOKENS = {
  tokens: [
    {
      name: 'ci',
      token: 'env:TOKEN_CI',
      scopes: ['lease:read', 'lease:write', 'pool:read', 'secrets:resolve'],
    },
    {
      name: 'admin',
      token: 'env:TOKEN_ADMIN',
      scopes: [
        'lease:read',
        'lease:write',
        'lease:admin',
        'pool:read',
        'resource:admin',
        'secrets:resolve',
      ],
    },
    { name: 'reader', token: 'env:TOKEN_READER', scopes: ['pool:read', 'lease:read'] },
  ],
};

export interface TestServer {
  engine: TestLeaseEngine;
  server: RunningServer;
  url: string;
  client(options?: {
    token?: string;
    owner?: string;
    requestTimeoutMs?: number;
    retries?: number;
  }): TestLeaseClient;
  close(): Promise<void>;
}

export async function startTestServer(
  options: {
    configInput?: Record<string, unknown>;
    dbPath?: string;
    logger?: Logger;
    secrets?: Record<string, string>;
  } = {},
): Promise<TestServer> {
  const { config } = validateConfig(options.configInput ?? buyersConfig(), '<test>');
  const engine = await createTestLease({
    config,
    dbPath: options.dbPath ?? ':memory:',
    logger: options.logger ?? noopLogger,
    secretResolvers: [new EnvSecretResolver(options.secrets ?? SECRETS)],
    version: 'test',
    authMode: config.auth.tokens.length ? 'token' : 'insecure-local',
  });
  const server = await startServer({ engine, logger: options.logger ?? noopLogger, port: 0 });
  return {
    engine,
    server,
    url: server.url,
    client: (o = {}) =>
      new TestLeaseClient({
        baseUrl: server.url,
        owner: 'test-owner',
        requestTimeoutMs: 5_000,
        retries: 1,
        ...o,
      }),
    close: () => server.close({ timeoutMs: 1000 }),
  };
}

export function tempDir(prefix = 'testlease-server-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

/** Same alternation check as in core: acquisitions per resource must not overlap (by event seq). */
export function assertNoOverlappingLeases(
  events: { seq: number; type: string; resourceId?: string; leaseId?: string }[],
): Record<string, number> {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const active = new Map<string, string>();
  const perResource: Record<string, number> = {};
  for (const e of sorted) {
    if (!e.resourceId) continue;
    if (e.type === 'LEASE_ACQUIRED') {
      const cur = active.get(e.resourceId);
      if (cur)
        throw new Error(
          `overlap on ${e.resourceId}: ${e.leaseId} acquired while ${cur} active (seq ${e.seq})`,
        );
      active.set(e.resourceId, e.leaseId!);
      perResource[e.resourceId] = (perResource[e.resourceId] ?? 0) + 1;
    } else if (e.type === 'LEASE_RELEASED' || e.type === 'LEASE_EXPIRED') {
      if (active.get(e.resourceId) !== e.leaseId)
        throw new Error(`${e.type} for ${e.leaseId} but active was ${active.get(e.resourceId)}`);
      active.delete(e.resourceId);
    }
  }
  return perResource;
}
