/**
 * Real MCP clients against real MCP servers over both transports.
 *
 *  - stdio: spawns the built CLI (`testlease mcp --url ...`) as a child process, like an agent host
 *    would, bridging to an HTTP TestLease server.
 *  - Streamable HTTP: the TestLease server with /mcp mounted, token-authenticated sessions.
 *
 * Every response is inspected for secret values and secret references.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { TestLeaseEngine } from '@testlease/core';
import { startServer, type RunningServer } from '@testlease/server';
import { createMcpHttpHandler } from '../src/index.js';
import { assertNoSecrets, makeEngine, SECRETS, sleep } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = join(here, '..', '..', 'cli', 'bin', 'testlease.js');

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

function text(r: ToolResult): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

const TOKENS = {
  tokens: [
    { name: 'agent', token: 'env:TOKEN_AGENT', scopes: ['lease:read', 'lease:write', 'pool:read'] },
    { name: 'other', token: 'env:TOKEN_OTHER', scopes: ['lease:read', 'lease:write', 'pool:read'] },
  ],
};

async function startHttp(
  engine: TestLeaseEngine,
  opts: { allowQuarantine?: boolean } = {},
): Promise<RunningServer> {
  return startServer({
    engine,
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    port: 0,
    extend: (app) => {
      const handler = createMcpHttpHandler({
        loopback: true,
        allowQuarantine: opts.allowQuarantine ?? false,
        authenticate: (request) => {
          const header = request.headers.get('authorization') ?? '';
          const token = header.replace(/^Bearer\s+/i, '');
          const match =
            engine.config.auth.tokens.length === 0
              ? { name: 'local' }
              : token === SECRETS.TOKEN_AGENT
                ? { name: 'agent' }
                : token === SECRETS.TOKEN_OTHER
                  ? { name: 'other' }
                  : null;
          return match ? { principal: match.name, api: engine.api.as(match.name) } : null;
        },
      });
      app.all('/mcp', (c) => handler.fetch(c.req.raw));
    },
  });
}

async function connectHttp(
  url: string,
  token?: string,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${url}/mcp`),
    token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {},
  );
  const client = new Client({ name: 'vitest-agent', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

/** Exercises the full agent workflow and checks every response for secrets. */
async function agentWorkflow(
  client: Client,
  engine: TestLeaseEngine,
  expectedOwnerPrefix: RegExp,
): Promise<void> {
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  expect(names).toEqual([
    'testlease_acquire',
    'testlease_get_lease',
    'testlease_lease_events',
    'testlease_list_pools',
    'testlease_pool_status',
    'testlease_release',
    'testlease_renew',
  ]);
  expect(names).not.toContain('testlease_quarantine');
  for (const t of tools.tools) {
    expect(t.annotations, t.name).toBeDefined();
    const readOnly = [
      'testlease_list_pools',
      'testlease_pool_status',
      'testlease_get_lease',
      'testlease_lease_events',
    ].includes(t.name);
    expect(t.annotations?.readOnlyHint, t.name).toBe(readOnly);
    expect(t.annotations?.destructiveHint ?? false, t.name).toBe(false);
  }
  assertNoSecrets(tools, 'tools/list');

  const pools = (await client.callTool({
    name: 'testlease_list_pools',
    arguments: {},
  })) as ToolResult;
  expect(pools.isError).toBeFalsy();
  expect(pools.structuredContent).toMatchObject({
    pools: [{ pool: 'buyers', available: 3, total: 3 }],
  });
  assertNoSecrets(pools, 'list_pools');

  const status = (await client.callTool({
    name: 'testlease_pool_status',
    arguments: { pool: 'buyers' },
  })) as ToolResult;
  expect(status.isError).toBeFalsy();
  const resources = (
    status.structuredContent as {
      resources: { resourceId: string; availableSecretKeys: string[] }[];
    }
  ).resources;
  expect(resources.map((r) => r.resourceId)).toEqual(['buyer-01', 'buyer-02', 'buyer-03']);
  expect(resources[0]!.availableSecretKeys).toEqual(['password']);
  assertNoSecrets(status, 'pool_status');

  const acquired = (await client.callTool({
    name: 'testlease_acquire',
    arguments: {
      pool: 'buyers',
      tags: { region: 'nl' },
      ttlSeconds: 600,
      waitSeconds: 5,
      purpose: 'run checkout accessibility test',
      clientRequestId: 'agent-session-1',
    },
  })) as ToolResult;
  expect(acquired.isError, text(acquired)).toBeFalsy();
  const lease = acquired.structuredContent as {
    leaseId: string;
    resourceId: string;
    pool: string;
    owner: string;
    metadata: Record<string, unknown>;
    availableSecretKeys: string[];
    expiresAt: string;
    reused: boolean;
  };
  expect(lease.leaseId).toMatch(/^lease_/);
  expect(lease.pool).toBe('buyers');
  expect(lease.resourceId).toMatch(/^buyer-0[12]$/);
  expect(lease.metadata).toEqual({ email: `${lease.resourceId.replace('-', '')}@example.test` });
  expect(lease.availableSecretKeys).toEqual(['password']);
  expect(lease.owner).toMatch(expectedOwnerPrefix);
  expect(lease.reused).toBe(false);
  expect(Object.keys(lease)).not.toContain('password');
  expect(Object.keys(lease)).not.toContain('secrets');
  assertNoSecrets(acquired, 'acquire');

  // Idempotent retry
  const retry = (await client.callTool({
    name: 'testlease_acquire',
    arguments: { pool: 'buyers', tags: { region: 'nl' }, clientRequestId: 'agent-session-1' },
  })) as ToolResult;
  expect((retry.structuredContent as { leaseId: string; reused: boolean }).leaseId).toBe(
    lease.leaseId,
  );
  expect((retry.structuredContent as { reused: boolean }).reused).toBe(true);

  const got = (await client.callTool({
    name: 'testlease_get_lease',
    arguments: { leaseId: lease.leaseId },
  })) as ToolResult;
  expect(got.structuredContent).toMatchObject({ leaseId: lease.leaseId, state: 'ACTIVE' });
  assertNoSecrets(got, 'get_lease');

  const renewed = (await client.callTool({
    name: 'testlease_renew',
    arguments: { leaseId: lease.leaseId, ttlSeconds: 900 },
  })) as ToolResult;
  expect(renewed.isError, text(renewed)).toBeFalsy();
  expect((renewed.structuredContent as { ttlSeconds: number }).ttlSeconds).toBe(900);
  assertNoSecrets(renewed, 'renew');

  // Server-side truth matches what the agent sees.
  expect(engine.service.getLease(lease.leaseId).owner).toBe(lease.owner);
  expect(engine.service.getPool('buyers').counts.leased).toBe(1);

  const events = (await client.callTool({
    name: 'testlease_lease_events',
    arguments: { leaseId: lease.leaseId },
  })) as ToolResult;
  const types = (events.structuredContent as { events: { type: string }[] }).events.map(
    (e) => e.type,
  );
  expect(types).toEqual(['LEASE_ACQUIRED', 'LEASE_REUSED', 'LEASE_RENEWED']);
  assertNoSecrets(events, 'lease_events');

  // Resources
  const list = await client.listResources();
  expect(list.resources.map((r) => r.uri)).toEqual(
    expect.arrayContaining(['testlease://pools', 'testlease://pools/buyers']),
  );
  const poolRes = await client.readResource({ uri: 'testlease://pools/buyers' });
  assertNoSecrets(poolRes, 'resource pools/buyers');
  expect(JSON.parse((poolRes.contents[0] as { text: string }).text)).toMatchObject({
    pool: 'buyers',
    leased: 1,
  });
  const leaseRes = await client.readResource({ uri: `testlease://leases/${lease.leaseId}` });
  assertNoSecrets(leaseRes, 'resource lease');
  expect(JSON.parse((leaseRes.contents[0] as { text: string }).text)).toMatchObject({
    leaseId: lease.leaseId,
    availableSecretKeys: ['password'],
  });
  const templates = await client.listResourceTemplates();
  expect(templates.resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
    'testlease://leases/{leaseId}',
    'testlease://pools/{pool}',
  ]);

  // Errors are tool results with isError, never thrown, and never leak.
  const bad = (await client.callTool({
    name: 'testlease_acquire',
    arguments: { pool: 'nope' },
  })) as ToolResult;
  expect(bad.isError).toBe(true);
  expect(text(bad)).toMatch(/^POOL_NOT_FOUND:/);
  const exhausted = (await client.callTool({
    name: 'testlease_acquire',
    arguments: { pool: 'buyers', tags: { region: 'be' } },
  })) as ToolResult;
  expect(exhausted.isError).toBeFalsy(); // buyer-03 is free
  const exhausted2 = (await client.callTool({
    name: 'testlease_acquire',
    arguments: { pool: 'buyers', tags: { region: 'be' } },
  })) as ToolResult;
  expect(exhausted2.isError).toBe(true);
  expect(text(exhausted2)).toMatch(/^POOL_EXHAUSTED:/);
  expect(text(exhausted2)).toMatch(/buyer-03\s+LEASED\s+owner=mcp/);
  assertNoSecrets(exhausted2, 'exhausted diagnostic');
  await client.callTool({
    name: 'testlease_release',
    arguments: { leaseId: (exhausted.structuredContent as { leaseId: string }).leaseId },
  });

  const released = (await client.callTool({
    name: 'testlease_release',
    arguments: { leaseId: lease.leaseId },
  })) as ToolResult;
  expect(released.isError, text(released)).toBeFalsy();
  expect((released.structuredContent as { outcome: string }).outcome).toBe('released');
  const again = (await client.callTool({
    name: 'testlease_release',
    arguments: { leaseId: lease.leaseId },
  })) as ToolResult;
  expect((again.structuredContent as { outcome: string }).outcome).toBe('already_released');
  expect(engine.service.getPool('buyers').counts.leased).toBe(0);
}

describe('MCP over stdio (testlease mcp bridging to an HTTP server)', () => {
  let engine: TestLeaseEngine;
  let server: RunningServer;
  let client: Client | undefined;

  beforeAll(async () => {
    if (!existsSync(join(here, '..', '..', 'cli', 'dist', 'cli.js')))
      throw new Error('CLI not built; run pnpm build');
    engine = await makeEngine();
    server = await startHttp(engine);
  });
  afterEach(async () => {
    await client?.close().catch(() => undefined);
    client = undefined;
  });
  afterAll(async () => {
    await server.close({ timeoutMs: 1000 });
  });

  it('runs the full agent workflow without ever seeing a secret', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliBin, 'mcp', '--url', server.url],
      env: { ...process.env, TESTLEASE_OWNER: 'mcp:vitest-stdio', NO_COLOR: '1' },
      stderr: 'pipe',
    });
    client = new Client({ name: 'vitest-stdio', version: '1.0.0' });
    await client.connect(transport);
    const info = client.getServerVersion();
    expect(info?.name).toBe('testlease');
    await agentWorkflow(client, engine, /^mcp:vitest-stdio$/);
  }, 60_000);

  it('an abandoned stdio session keeps its lease until the TTL reclaims it', async () => {
    const short = await makeEngine({
      pools: { p: { defaultTtl: '1s', resources: [{ id: 'only' }] } },
    });
    const shortServer = await startHttp(short);
    try {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [cliBin, 'mcp', '--url', shortServer.url],
        env: { ...process.env, TESTLEASE_OWNER: 'mcp:abandoned' },
        stderr: 'pipe',
      });
      const c = new Client({ name: 'vitest-abandon', version: '1.0.0' });
      await c.connect(transport);
      const acquired = (await c.callTool({
        name: 'testlease_acquire',
        arguments: { pool: 'p' },
      })) as ToolResult;
      const leaseId = (acquired.structuredContent as { leaseId: string }).leaseId;
      await c.close(); // the agent host kills the bridge; nothing released
      expect(['ACTIVE', 'EXPIRED']).toContain(short.service.getLease(leaseId).state);
      await sleep(1_300);
      expect(short.service.getLease(leaseId)).toMatchObject({
        state: 'EXPIRED',
        endReason: 'EXPIRED',
      });
      expect(short.service.getResource('only').state).toBe('AVAILABLE');
    } finally {
      await shortServer.close({ timeoutMs: 1000 });
    }
  }, 30_000);
});

describe('MCP over Streamable HTTP (mounted on the TestLease server)', () => {
  let engine: TestLeaseEngine;
  let server: RunningServer;

  beforeAll(async () => {
    engine = await makeEngine({ auth: TOKENS });
    server = await startHttp(engine);
  });
  afterAll(async () => {
    await server.close({ timeoutMs: 1000 });
  });

  it('rejects unauthenticated sessions', async () => {
    const res = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'x', version: '1' },
        },
      }),
    });
    expect(res.status).toBe(401);
    const err = await connectHttp(server.url).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
  });

  it('runs the full agent workflow as the token principal; sessions are isolated per token', async () => {
    const { client, transport } = await connectHttp(server.url, SECRETS.TOKEN_AGENT);
    try {
      await agentWorkflow(client, engine, /^mcp:agent:[0-9a-f]{8}$/);
      expect(transport.sessionId).toBeDefined();

      // Another token cannot hijack this session id.
      const hijack = await fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${SECRETS.TOKEN_OTHER}`,
          'mcp-session-id': transport.sessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
      });
      expect(hijack.status).toBe(403);

      // Another principal cannot release this session's lease through its own session.
      const acquired = (await client.callTool({
        name: 'testlease_acquire',
        arguments: { pool: 'buyers' },
      })) as ToolResult;
      const leaseId = (acquired.structuredContent as { leaseId: string }).leaseId;
      const other = await connectHttp(server.url, SECRETS.TOKEN_OTHER);
      try {
        const attempt = (await other.client.callTool({
          name: 'testlease_release',
          arguments: { leaseId },
        })) as ToolResult;
        expect(attempt.isError).toBe(true);
        expect(text(attempt)).toMatch(/^LEASE_OWNERSHIP_MISMATCH:/);
        expect(engine.service.getLease(leaseId).state).toBe('ACTIVE');
      } finally {
        await other.client.close();
      }
      await client.callTool({ name: 'testlease_release', arguments: { leaseId } });
    } finally {
      await client.close();
    }
  }, 60_000);

  it('closing an HTTP session does not release its leases; the TTL does', async () => {
    const short = await makeEngine({
      auth: TOKENS,
      pools: { p: { defaultTtl: '1s', resources: [{ id: 'only' }] } },
    });
    const shortServer = await startHttp(short);
    try {
      const { client, transport } = await connectHttp(shortServer.url, SECRETS.TOKEN_AGENT);
      const acquired = (await client.callTool({
        name: 'testlease_acquire',
        arguments: { pool: 'p' },
      })) as ToolResult;
      const leaseId = (acquired.structuredContent as { leaseId: string }).leaseId;
      await transport.terminateSession();
      await client.close();
      expect(['ACTIVE', 'EXPIRED']).toContain(short.service.getLease(leaseId).state);
      await sleep(1_300);
      expect(short.service.getLease(leaseId).state).toBe('EXPIRED');
      expect(short.service.getResource('only').state).toBe('AVAILABLE');
    } finally {
      await shortServer.close({ timeoutMs: 1000 });
    }
  }, 30_000);

  it('the quarantine tool exists only when explicitly enabled', async () => {
    const enabled = await makeEngine({ auth: TOKENS });
    const enabledServer = await startHttp(enabled, { allowQuarantine: true });
    try {
      const { client } = await connectHttp(enabledServer.url, SECRETS.TOKEN_AGENT);
      const tools = (await client.listTools()).tools;
      const q = tools.find((t) => t.name === 'testlease_quarantine');
      expect(q).toBeDefined();
      expect(q!.annotations?.destructiveHint).toBe(true);
      const acquired = (await client.callTool({
        name: 'testlease_acquire',
        arguments: { pool: 'buyers', tags: { region: 'be' } },
      })) as ToolResult;
      const leaseId = (acquired.structuredContent as { leaseId: string }).leaseId;
      const res = (await client.callTool({
        name: 'testlease_quarantine',
        arguments: { leaseId, reason: 'account locked' },
      })) as ToolResult;
      expect(res.isError, text(res)).toBeFalsy();
      assertNoSecrets(res, 'quarantine');
      expect(enabled.service.getResource('buyer-03').state).toBe('QUARANTINED');
      await client.close();
    } finally {
      await enabledServer.close({ timeoutMs: 1000 });
    }
  }, 30_000);
});
