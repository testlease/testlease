/**
 * `testlease_diagnose` over both transports against a pool with a real, flaky history: more
 * workers than resources, an immediate rejection, a waited timeout, expiries and quarantines.
 * Every response is inspected for secret values, secret references and private request fields.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { TestLeaseEngine } from '@testlease/core';
import type { AcquireResponse } from '@testlease/protocol';
import type { RunningServer } from '@testlease/server';
import type { McpPoolDiagnosis } from './diagnosis-contract.js';
import {
  assertNoSecrets,
  connectHttp,
  makeEngine,
  SECRETS,
  sleep,
  startHttp,
  text,
  TOKENS,
  type ToolResult,
} from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = join(here, '..', '..', 'cli', 'bin', 'testlease.js');

const PURPOSE = 'diag-purpose-marker';
const REQUEST_ID = 'diag-request-id-marker';

const DIAG_POOLS = {
  pools: {
    diag: {
      defaultTtl: '10m',
      resources: [
        { id: 'diag-01', secrets: { password: 'env:BUYER_01_PASSWORD' } },
        { id: 'diag-02', secrets: { password: 'env:BUYER_02_PASSWORD' } },
      ],
    },
  },
};

interface Scenario {
  leases: AcquireResponse[];
  quarantinedNow: string;
  /** Ends the waiter that is still queued while the tool runs and frees the pool. */
  cleanup(): Promise<void>;
}

/**
 * Two resources, ten workers. Driven through the in-process API with real waits; the only
 * sleep waits for 1s TTLs to elapse.
 */
async function seedScenario(engine: TestLeaseEngine): Promise<Scenario> {
  const api = engine.api;
  const acquire = (owner: string, extra: Record<string, unknown> = {}) =>
    api.acquire({ pool: 'diag', owner, ...extra });
  const leases: AcquireResponse[] = [];

  const a = await acquire('worker-1', { purpose: PURPOSE, clientRequestId: REQUEST_ID });
  const b = await acquire('worker-2');
  leases.push(a, b);
  await api.resolveSecrets(a.lease.leaseId, { owner: 'worker-1' });

  // Immediate rejection: the pool is full and the caller does not wait.
  await expect(acquire('worker-3', { waitTimeoutMs: 0 })).rejects.toMatchObject({
    code: 'POOL_EXHAUSTED',
  });

  // worker-4 queues first; worker-5 queues behind it and times out for real.
  const queued = acquire('worker-4', { waitTimeoutMs: 30_000 });
  await expect(acquire('worker-5', { waitTimeoutMs: 300 })).rejects.toMatchObject({
    code: 'ACQUIRE_TIMEOUT',
  });
  await api.release(a.lease.leaseId, { owner: 'worker-1' });
  const c = await queued;
  leases.push(c);
  expect(c.lease.resourceId).toBe(a.lease.resourceId);
  expect(c.waitedMs).toBeGreaterThan(0);
  await api.release(c.lease.leaseId, { owner: 'worker-4' });

  // Two expiries: worker-6 never heartbeats, worker-2 heartbeats once and then stops.
  const e = await acquire('worker-6', { ttlMs: 1_000 });
  leases.push(e);
  await api.renew(b.lease.leaseId, { owner: 'worker-2', ttlMs: 1_000 });
  await sleep(1_300); // let both 1s TTLs elapse
  engine.service.expireDue();
  expect(engine.service.getLease(e.lease.leaseId).state).toBe('EXPIRED');
  expect(engine.service.getLease(b.lease.leaseId).state).toBe('EXPIRED');

  // Two quarantines; the second resource is restored and leased again.
  const f = await acquire('worker-7');
  await api.quarantine(f.lease.leaseId, { owner: 'worker-7', reason: 'account locked' });
  const g = await acquire('worker-8');
  await api.quarantine(g.lease.leaseId, { owner: 'worker-8', reason: 'captcha wall' });
  await api.restoreResource(g.lease.resourceId);
  const h = await acquire('worker-9');
  leases.push(f, g, h);
  expect(h.lease.resourceId).toBe(g.lease.resourceId);

  // One caller is still waiting while the tool runs; aborting it later writes no event.
  const abort = new AbortController();
  const waiting = api
    .acquire({ pool: 'diag', owner: 'worker-10', waitTimeoutMs: 30_000 }, { signal: abort.signal })
    .catch((err: unknown) => err);
  await expect.poll(() => engine.service.getPool('diag').waiters.length).toBe(1);

  return {
    leases,
    quarantinedNow: f.lease.resourceId,
    async cleanup() {
      abort.abort();
      await waiting;
      await api.release(h.lease.leaseId, { owner: 'worker-9' });
    },
  };
}

function leasesPerResource(leases: AcquireResponse[]): { resourceId: string; count: number }[] {
  const counts = new Map<string, number>([
    ['diag-01', 0],
    ['diag-02', 0],
  ]);
  for (const l of leases) counts.set(l.lease.resourceId, counts.get(l.lease.resourceId)! + 1);
  return [...counts]
    .map(([resourceId, count]) => ({ resourceId, count }))
    .sort((x, y) => y.count - x.count || x.resourceId.localeCompare(y.resourceId));
}

async function expectRealisticDiagnosis(client: Client, engine: TestLeaseEngine): Promise<void> {
  const scenario = await seedScenario(engine);
  try {
    const before = Date.now();
    const res = (await client.callTool({
      name: 'testlease_diagnose',
      arguments: { pool: 'diag' },
    })) as ToolResult;
    const after = Date.now();
    expect(res.isError, text(res)).toBeFalsy();
    const { events } = await engine.api.listPoolEvents('diag', { sinceMs: 0 });
    const fetched = events.length;
    const waitedOf = (e: (typeof events)[number]) => e.details?.waitedMs as number;
    // The source of truth for durations is the event data, not wall time.
    const waitedAcquires = events
      .filter((e) => e.type === 'LEASE_ACQUIRED' && waitedOf(e) > 0)
      .map(waitedOf);
    const waitedTimeouts = events
      .filter((e) => e.type === 'ACQUIRE_TIMEOUT' && e.details?.immediate !== true)
      .map(waitedOf);
    expect(waitedAcquires).toHaveLength(1);
    expect(waitedTimeouts).toHaveLength(1);
    const [acquireWait] = waitedAcquires as [number];
    const [timeoutWait] = waitedTimeouts as [number];

    const d = res.structuredContent as unknown as McpPoolDiagnosis;
    expect(d.pool).toBe('diag');

    expect(d.waiting).toMatchObject({ acquired: 7, waited: 1, currentWaiters: 1 });
    expect(acquireWait).toBeGreaterThan(0);
    expect(d.waiting.waitedMs).toEqual({ p50: acquireWait, p95: acquireWait, max: acquireWait });

    expect(d.poolExhausted).toEqual({ count: 1 });
    expect(d.acquireTimeouts.count).toBe(1);
    expect(timeoutWait).toBeGreaterThan(0);
    expect(d.acquireTimeouts.waitedMs).toEqual({
      p50: timeoutWait,
      p95: timeoutWait,
      max: timeoutWait,
    });

    expect(d.expiries).toMatchObject({
      count: 2,
      noHeartbeatEver: 1,
      heartbeatStopped: 1,
      topResources: [
        { resourceId: 'diag-01', count: 1 },
        { resourceId: 'diag-02', count: 1 },
      ],
      topOwners: [
        { owner: 'worker-2', count: 1 },
        { owner: 'worker-6', count: 1 },
      ],
    });
    expect(d.expiries.maxOverdueMs).toBeGreaterThanOrEqual(0);

    expect(d.quarantine).toEqual({
      quarantined: 2,
      restored: 1,
      reasons: [
        { reason: 'account locked', count: 1 },
        { reason: 'captcha wall', count: 1 },
      ],
      current: [{ resourceId: scenario.quarantinedNow, reason: 'account locked' }],
    });

    // 7 acquisitions + 2 timeouts; 1 waited + 2 rejected.
    expect(d.contention).toMatchObject({ attempts: 9, waitedOrRejected: 3 });
    expect(d.contention.ratio).toBeCloseTo(1 / 3, 10);
    expect(d.contention.leasesPerResource).toEqual(leasesPerResource(scenario.leases));

    const windowMs = 1440 * 60_000;
    expect(d.meta).toMatchObject({
      windowMinutes: 1440,
      eventsScanned: fetched,
      possiblyTruncated: false,
      abortedAcquiresTracked: false,
    });
    expect(d.meta.notes.some((n) => /reaper/i.test(n))).toBe(true);
    const windowStart = Date.parse(d.meta.windowStart);
    expect(windowStart).toBeGreaterThanOrEqual(before - windowMs - 5_000);
    expect(windowStart).toBeLessThanOrEqual(after - windowMs + 5_000);

    // Text and structured output alike: no secrets, no private request fields.
    assertNoSecrets(res, 'diagnose');
    const whole = JSON.stringify(res);
    for (const forbidden of [PURPOSE, REQUEST_ID, 'principal', 'clientRequestId', 'secretKeys']) {
      expect(whole, forbidden).not.toContain(forbidden);
    }
    expect(text(res)).toContain('diag');
  } finally {
    await scenario.cleanup();
  }
}

async function expectToolListed(client: Client, label: string): Promise<void> {
  const { tools } = await client.listTools();
  // Adding the tool leaves every existing tool's schema and annotations unchanged.
  const existing = tools
    .filter((t) => t.name !== 'testlease_diagnose')
    .sort((x, y) => x.name.localeCompare(y.name));
  expect(existing).toMatchSnapshot(`existing tools (${label})`);

  const diag = tools.find((t) => t.name === 'testlease_diagnose');
  expect(diag, 'testlease_diagnose is always registered').toBeDefined();
  expect(diag!.annotations).toMatchObject({
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  });
  expect(diag!.annotations?.destructiveHint ?? false).toBe(false);
  const props = diag!.inputSchema.properties as Record<string, Record<string, unknown>>;
  const poolStatus = tools.find((t) => t.name === 'testlease_pool_status')!;
  expect(props.pool).toEqual((poolStatus.inputSchema.properties as Record<string, unknown>).pool);
  expect(props.windowMinutes).toMatchObject({ minimum: 1, maximum: 43_200 });
  expect(diag!.inputSchema.required ?? []).toEqual(['pool']);
  assertNoSecrets(tools, 'tools/list');
}

async function expectInputErrors(client: Client): Promise<void> {
  const unknown = (await client.callTool({
    name: 'testlease_diagnose',
    arguments: { pool: 'nope' },
  })) as ToolResult;
  expect(unknown.isError).toBe(true);
  expect(text(unknown)).toMatch(/^POOL_NOT_FOUND:/);
  assertNoSecrets(unknown, 'diagnose unknown pool');

  for (const windowMinutes of [0, 43_201]) {
    const bad = (await client.callTool({
      name: 'testlease_diagnose',
      arguments: { pool: 'diag', windowMinutes },
    })) as ToolResult;
    expect(bad.isError, `windowMinutes ${windowMinutes}`).toBe(true);
    expect(text(bad)).toMatch(/^Input validation error: .*testlease_diagnose/);
    expect(text(bad)).toMatch(/windowMinutes/);
  }
  for (const windowMinutes of [1, 43_200]) {
    const ok = (await client.callTool({
      name: 'testlease_diagnose',
      arguments: { pool: 'diag', windowMinutes },
    })) as ToolResult;
    expect(ok.isError, text(ok)).toBeFalsy();
    expect((ok.structuredContent as unknown as McpPoolDiagnosis).meta.windowMinutes).toBe(
      windowMinutes,
    );
  }
}

describe('testlease_diagnose over stdio (testlease mcp bridging to an HTTP server)', () => {
  let engine: TestLeaseEngine;
  let server: RunningServer;
  let client: Client;

  beforeAll(async () => {
    if (!existsSync(join(here, '..', '..', 'cli', 'dist', 'cli.js')))
      throw new Error('CLI not built; run pnpm build');
    engine = await makeEngine(DIAG_POOLS);
    server = await startHttp(engine);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliBin, 'mcp', '--url', server.url],
      env: { ...process.env, TESTLEASE_OWNER: 'mcp:vitest-diagnose', NO_COLOR: '1' },
      stderr: 'pipe',
    });
    client = new Client({ name: 'vitest-diagnose-stdio', version: '1.0.0' });
    await client.connect(transport);
  });
  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await server.close({ timeoutMs: 1000 });
  });

  it('lists testlease_diagnose with read-only annotations; existing tools are unchanged', async () => {
    await expectToolListed(client, 'stdio');
  });

  it('explains a flaky pool section by section without leaking secrets', async () => {
    await expectRealisticDiagnosis(client, engine);
  }, 60_000);

  it('reports unknown pools and out-of-range windows as errors', async () => {
    await expectInputErrors(client);
  });
});

describe('testlease_diagnose over Streamable HTTP (mounted on the TestLease server)', () => {
  let engine: TestLeaseEngine;
  let server: RunningServer;
  let client: Client;

  beforeAll(async () => {
    engine = await makeEngine({ auth: TOKENS, ...DIAG_POOLS });
    server = await startHttp(engine);
    ({ client } = await connectHttp(server.url, SECRETS.TOKEN_AGENT));
  });
  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await server.close({ timeoutMs: 1000 });
  });

  it('lists testlease_diagnose with read-only annotations; existing tools are unchanged', async () => {
    await expectToolListed(client, 'http');
  });

  it('explains a flaky pool section by section without leaking secrets', async () => {
    await expectRealisticDiagnosis(client, engine);
  }, 60_000);

  it('reports unknown pools and out-of-range windows as errors', async () => {
    await expectInputErrors(client);
  });
});
