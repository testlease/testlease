import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { MCP_VERSION } from './version.js';
import {
  isTestLeaseError,
  POOL_EVENTS_LIMIT,
  type TestLeaseApi,
  type TestLeaseError,
} from '@testlease/protocol';
import {
  toMcpAcquireResult,
  toMcpLease,
  toMcpPoolDiagnosis,
  toMcpPoolStatus,
  toMcpPoolSummary,
  toMcpResource,
  type McpAcquireResult,
  type McpLease,
  type McpPercentiles,
  type McpPoolDiagnosis,
  type McpPoolStatus,
  type McpPoolSummary,
} from './sanitize.js';

export interface TestLeaseMcpOptions {
  /**
   * Leasing API bound to this MCP identity (in-process for Streamable HTTP inside the server,
   * the HTTP client for a stdio bridge). Typed as `TestLeaseApi`: no secret resolution exists here.
   */
  api: TestLeaseApi;
  /** Stable logical owner for leases acquired through this MCP server, e.g. `mcp:claude-session-1`. */
  owner: string;
  /** Register `testlease_quarantine` (off by default; see ADR-0004). */
  allowQuarantine?: boolean;
  /** Upper bound for the per-call wait (default 120s). */
  maxWaitSeconds?: number;
  /** Default wait when the agent does not specify one (default 0 = fail fast). */
  defaultWaitSeconds?: number;
  version?: string;
}

export const MCP_SERVER_NAME = 'testlease';

const DIAGNOSE_DEFAULT_WINDOW_MINUTES = 1440;
const DIAGNOSE_MAX_WINDOW_MINUTES = 43_200;

const poolName = z.string().min(1).max(128).describe('Pool name, e.g. "premium-buyers"');
const leaseId = z
  .string()
  .min(1)
  .max(128)
  .describe('Lease id returned by testlease_acquire, e.g. "lease_ab12..."');
const tags = z
  .record(z.string(), z.string())
  .optional()
  .describe('Required resource tags, e.g. {"region":"nl"}');

const errorText = (err: unknown): string => {
  if (isTestLeaseError(err)) {
    const e = err as TestLeaseError;
    return `${e.code}: ${e.message}`;
  }
  return err instanceof Error ? err.message : String(err);
};

/**
 * Builds the TestLease MCP server. The adapter is deliberately thin: every tool forwards to
 * the same `TestLeaseApi` the REST API and the CLI use, and every result passes through the
 * allow-list projections in `sanitize.ts`. Secret values are structurally unreachable here.
 */
export function createTestLeaseMcpServer(options: TestLeaseMcpOptions): McpServer {
  const { api, owner } = options;
  const maxWait = options.maxWaitSeconds ?? 120;
  const defaultWait = options.defaultWaitSeconds ?? 0;

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: options.version ?? MCP_VERSION },
    {
      instructions: [
        'TestLease hands out exclusive, expiring leases on scarce shared resources (test accounts, API keys, browser profiles, devices, tenants).',
        'Workflow: testlease_pool_status -> testlease_acquire -> run the work -> testlease_release.',
        'Leases expire after their TTL unless renewed with testlease_renew; a crashed process therefore never blocks a resource forever.',
        'You receive resource metadata and the *names* of secrets, never secret values; to use them, hand the leaseId to a runner, which resolves them on your behalf (for example `testlease exec --lease <leaseId> -- <command>`).',
        `Leases you acquire are owned by "${owner}"; you can only renew or release your own leases.`,
      ].join(' '),
    },
  );

  const ok = <T>(structured: T, text: string) => ({
    content: [{ type: 'text' as const, text }],
    structuredContent: structured as Record<string, unknown>,
  });
  const fail = (err: unknown) => ({
    content: [{ type: 'text' as const, text: errorText(err) }],
    isError: true,
  });

  server.registerTool(
    'testlease_list_pools',
    {
      title: 'List resource pools',
      description:
        'Lists every pool with available/leased/quarantined counts and how many callers are waiting.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const pools = (await api.listPools()).map(toMcpPoolSummary);
        return ok({ pools }, formatPools(pools));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'testlease_pool_status',
    {
      title: 'Inspect a pool',
      description:
        'Shows every resource in a pool with its state, tags, current owner and lease expiry, plus who is waiting.',
      inputSchema: z.object({ pool: poolName }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ pool }) => {
      try {
        const status = toMcpPoolStatus(await api.getPool(pool));
        return ok(status, formatPoolStatus(status));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'testlease_acquire',
    {
      title: 'Acquire a resource lease',
      description:
        'Acquires an exclusive lease on one resource of the pool that matches the tags. Returns lease id, resource metadata and the names of available secrets (never values). Fails fast with POOL_EXHAUSTED unless waitSeconds > 0. Reusing the same clientRequestId returns the same lease instead of a second one.',
      inputSchema: z.object({
        pool: poolName,
        tags,
        ttlSeconds: z
          .number()
          .int()
          .min(1)
          .max(7 * 86_400)
          .optional()
          .describe('Lease TTL; defaults to the pool default. Renew before it elapses.'),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(maxWait)
          .optional()
          .describe(`How long to wait for a free resource (0-${maxWait}, default ${defaultWait}).`),
        purpose: z
          .string()
          .max(500)
          .optional()
          .describe('Why you need it, shown to humans in diagnostics'),
        clientRequestId: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Idempotency key; repeat it when retrying'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const res = await api.acquire({
          pool: input.pool,
          owner,
          tags: input.tags ?? {},
          ...(input.ttlSeconds ? { ttlMs: input.ttlSeconds * 1000 } : {}),
          waitTimeoutMs: (input.waitSeconds ?? defaultWait) * 1000,
          ...(input.purpose ? { purpose: input.purpose } : {}),
          ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
          context: { via: 'mcp' },
        });
        const result = toMcpAcquireResult(res);
        return ok(result, formatAcquire(result));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'testlease_get_lease',
    {
      title: 'Get a lease',
      description:
        'Returns the current state of a lease (ACTIVE, RELEASED or EXPIRED) and its resource snapshot.',
      inputSchema: z.object({ leaseId }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ leaseId: id }) => {
      try {
        const lease = toMcpLease(await api.getLease(id));
        return ok(lease, formatLease(lease));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'testlease_renew',
    {
      title: 'Renew (heartbeat) a lease',
      description:
        'Extends the expiry of a lease you own. Call it before the TTL elapses during long work.',
      inputSchema: z.object({
        leaseId,
        ttlSeconds: z
          .number()
          .int()
          .min(1)
          .max(7 * 86_400)
          .optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ leaseId: id, ttlSeconds }) => {
      try {
        const res = await api.renew(id, {
          owner,
          ...(ttlSeconds ? { ttlMs: ttlSeconds * 1000 } : {}),
        });
        const lease = toMcpLease(res.lease);
        return ok(lease, `Lease ${lease.leaseId} renewed; expires ${lease.expiresAt}.`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'testlease_release',
    {
      title: 'Release a lease',
      description:
        'Returns the resource to the pool. Idempotent: releasing an already released or expired lease is harmless.',
      inputSchema: z.object({ leaseId }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ leaseId: id }) => {
      try {
        const res = await api.release(id, { owner });
        const lease = toMcpLease(res.lease);
        return ok(
          { ...lease, outcome: res.outcome },
          `Lease ${lease.leaseId} on ${lease.resourceId}: ${res.outcome.replace('_', ' ')}.`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'testlease_lease_events',
    {
      title: 'Lease event history',
      description:
        'Returns the evidence trail of a lease: acquired, renewed, released, expired, quarantined.',
      inputSchema: z.object({ leaseId }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ leaseId: id }) => {
      try {
        const { events } = await api.listLeaseEvents(id);
        const list = events.map((e) => ({
          seq: e.seq,
          at: new Date(e.at).toISOString(),
          type: e.type,
          ...(e.owner ? { owner: e.owner } : {}),
          ...(e.details ? { details: e.details } : {}),
        }));
        return ok(
          { leaseId: id, events: list },
          list.map((e) => `${e.at} ${e.type}${e.owner ? ` owner=${e.owner}` : ''}`).join('\n') ||
            'No events.',
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'testlease_diagnose',
    {
      title: 'Diagnose a flaky pool',
      description:
        'Explains pool-level causes of flaky tests or stuck agents over a recent window: how often and how long callers waited, immediate rejections (POOL_EXHAUSTED) vs wait timeouts, lease expiries (never heartbeated vs heartbeat stopped), quarantines, and how leases spread over resources.',
      inputSchema: z.object({
        pool: poolName,
        windowMinutes: z
          .number()
          .int()
          .min(1)
          .max(DIAGNOSE_MAX_WINDOW_MINUTES)
          .optional()
          .describe(
            `How far back to look, in minutes (1-${DIAGNOSE_MAX_WINDOW_MINUTES}, default ${DIAGNOSE_DEFAULT_WINDOW_MINUTES}).`,
          ),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ pool, windowMinutes = DIAGNOSE_DEFAULT_WINDOW_MINUTES }) => {
      try {
        // The window is anchored on this process's clock; over stdio it may be skewed from the
        // server's (see docs/mcp.md).
        const startMs = Date.now() - windowMinutes * 60_000;
        const limit = POOL_EVENTS_LIMIT.max;
        const [{ events }, detail] = await Promise.all([
          api.listPoolEvents(pool, { sinceMs: startMs, limit }),
          api.getPool(pool),
        ]);
        const diagnosis = toMcpPoolDiagnosis(events, detail, { startMs, limit, windowMinutes });
        return ok(diagnosis, formatDiagnosis(diagnosis));
      } catch (err) {
        return fail(err);
      }
    },
  );

  if (options.allowQuarantine) {
    server.registerTool(
      'testlease_quarantine',
      {
        title: 'Quarantine a leased resource',
        description:
          'Ends your lease and marks the resource unusable for everyone until an operator restores it. Use only when the resource is contaminated (locked account, corrupted state).',
        inputSchema: z.object({ leaseId, reason: z.string().min(1).max(1000) }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ leaseId: id, reason }) => {
        try {
          const res = await api.quarantine(id, { owner, reason });
          const resource = toMcpResource(res.resource);
          return ok(
            { lease: toMcpLease(res.lease), resource },
            `Resource ${resource.resourceId} quarantined: ${reason}. An operator can restore it with: testlease restore ${resource.resourceId}`,
          );
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  // ---- read-only resources -----------------------------------------------------------------
  server.registerResource(
    'pools',
    'testlease://pools',
    {
      title: 'Resource pools',
      description: 'All pools with capacity counts',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ pools: (await api.listPools()).map(toMcpPoolSummary) }, null, 2),
        },
      ],
    }),
  );
  server.registerResource(
    'pool',
    new ResourceTemplate('testlease://pools/{pool}', {
      list: async () => ({
        resources: (await api.listPools()).map((p) => ({
          uri: `testlease://pools/${encodeURIComponent(p.name)}`,
          name: p.name,
          mimeType: 'application/json',
        })),
      }),
      complete: {
        pool: async (value) =>
          (await api.listPools()).map((p) => p.name).filter((n) => n.startsWith(value)),
      },
    }),
    {
      title: 'Pool status',
      description: 'Resources of one pool with state, owner and expiry',
      mimeType: 'application/json',
    },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(toMcpPoolStatus(await api.getPool(String(variables.pool))), null, 2),
        },
      ],
    }),
  );
  server.registerResource(
    'lease',
    new ResourceTemplate('testlease://leases/{leaseId}', { list: undefined }),
    {
      title: 'Lease',
      description: 'One lease by id (state, resource snapshot, expiry)',
      mimeType: 'application/json',
    },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(toMcpLease(await api.getLease(String(variables.leaseId))), null, 2),
        },
      ],
    }),
  );

  return server;
}

function formatPools(pools: McpPoolSummary[]): string {
  if (pools.length === 0) return 'No pools configured.';
  return pools
    .map(
      (p) =>
        `${p.pool}: ${p.available} available, ${p.leased} leased, ${p.quarantined} quarantined, ${p.total} total${p.waiting ? `, ${p.waiting} waiting` : ''}`,
    )
    .join('\n');
}

function formatPoolStatus(s: McpPoolStatus): string {
  const lines = [
    `${s.pool}: ${s.available} available, ${s.leased} leased, ${s.quarantined} quarantined, ${s.total} total (default TTL ${s.defaultTtlSeconds}s)`,
  ];
  for (const r of s.resources) {
    const tagText = Object.entries(r.tags)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    lines.push(
      `  ${r.resourceId}  ${r.state}${tagText ? `  ${tagText}` : ''}${r.leasedBy ? `  owner=${r.leasedBy} expires=${r.leaseExpiresAt}` : ''}${r.quarantineReason ? `  ${r.quarantineReason}` : ''}`,
    );
  }
  if (s.waiters.length)
    lines.push(
      `  waiting: ${s.waiters.map((w) => `${w.owner} (${w.waitingSeconds}s)`).join(', ')}`,
    );
  return lines.join('\n');
}

function formatLease(l: McpLease): string {
  return `Lease ${l.leaseId} (${l.state}) on ${l.resourceId} in ${l.pool}, owner ${l.owner}, expires ${l.expiresAt}. Secrets available to authorized runners: ${l.availableSecretKeys.join(', ') || 'none'}.`;
}

function formatAcquire(r: McpAcquireResult): string {
  return `${r.reused ? 'Existing lease returned' : 'Acquired'} ${r.resourceId} in ${r.pool} as lease ${r.leaseId}${r.waitedSeconds ? ` after waiting ${r.waitedSeconds}s` : ''}. Expires ${r.expiresAt} (TTL ${r.ttlSeconds}s); renew with testlease_renew if the work takes longer, release with testlease_release when done. Metadata: ${JSON.stringify(r.metadata)}. Secret names (values only via an authorized runner): ${r.availableSecretKeys.join(', ') || 'none'}.`;
}

function formatDiagnosis(d: McpPoolDiagnosis): string {
  const ms = (p: McpPercentiles | null) =>
    p ? ` (p50 ${p.p50}ms, p95 ${p.p95}ms, max ${p.max}ms)` : '';
  const pct = d.contention.ratio === null ? 'n/a' : `${Math.round(d.contention.ratio * 100)}%`;
  const { expiries: x, quarantine: q } = d;
  const lines = [
    `${d.pool}, last ${d.meta.windowMinutes} min since ${d.meta.windowStart}:`,
    `  acquired ${d.waiting.acquired}, ${d.waiting.waited} after waiting${ms(d.waiting.waitedMs)}; ${d.waiting.currentWaiters} waiting now`,
    `  rejected immediately (pool exhausted): ${d.poolExhausted.count}; wait timeouts: ${d.acquireTimeouts.count}${ms(d.acquireTimeouts.waitedMs)}`,
    `  expiries: ${x.count} (${x.noHeartbeatEver} never heartbeated, ${x.heartbeatStopped} heartbeat stopped${x.maxOverdueMs === null ? '' : `, max overdue ${x.maxOverdueMs}ms`})`,
  ];
  if (x.topResources.length)
    lines.push(
      `    by resource: ${x.topResources.map((r) => `${r.resourceId}=${r.count}`).join(', ')}`,
      `    by owner: ${x.topOwners.map((o) => `${o.owner}=${o.count}`).join(', ')}`,
    );
  lines.push(
    `  quarantined ${q.quarantined}, restored ${q.restored}${q.reasons.length ? ` (${q.reasons.map((r) => `${r.reason}: ${r.count}`).join('; ')})` : ''}`,
  );
  if (q.current.length)
    lines.push(
      `    quarantined now: ${q.current.map((r) => `${r.resourceId} (${r.reason})`).join(', ')}`,
    );
  lines.push(
    `  contention: ${d.contention.waitedOrRejected}/${d.contention.attempts} attempts waited or were rejected (${pct})`,
    `    leases per resource: ${d.contention.leasesPerResource.map((r) => `${r.resourceId}=${r.count}`).join(', ') || 'none'}`,
    ...d.meta.notes.map((n) => `  note: ${n}`),
  );
  return lines.join('\n');
}
