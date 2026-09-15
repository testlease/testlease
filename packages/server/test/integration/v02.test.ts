import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestLeaseError } from '@testlease/protocol';
import {
  createTestLease,
  EnvSecretResolver,
  loadRuntimeConfig,
  noopLogger,
  validateConfig,
  type TestLeaseEngine,
} from '@testlease/core';
import { TestLeaseClient } from '@testlease/client';
import { documentedRoutes, startServer, type RunningServer } from '../../src/index.js';
import {
  buyersConfig,
  expectError,
  SECRETS,
  sleep,
  startTestServer,
  TOKENS,
  waitFor,
  type TestServer,
} from '../helpers.js';

describe('v0.2 operator features over HTTP', () => {
  let ts: TestServer | undefined;
  afterEach(async () => {
    await ts?.close();
    ts = undefined;
  });

  it('every registered route is documented in the OpenAPI document and vice versa', async () => {
    ts = await startTestServer();
    const registered = [
      ...new Set(
        ts.server.app.routes
          .filter((r) => r.method !== 'ALL' && !r.path.includes('*'))
          .map((r) => `${r.method} ${r.path}`),
      ),
    ].sort();
    expect(registered).toEqual(documentedRoutes());
    const res = await fetch(`${ts.url}/openapi.json`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { openapi: string }).openapi).toBe('3.1.0');
  });

  it('lists leases with filters and exposes metrics', async () => {
    ts = await startTestServer();
    const client = ts.client({ owner: 'w1' });
    const a = await client.acquire({ pool: 'buyers', owner: 'w1' });
    const b = await client.acquire({ pool: 'buyers', owner: 'w2' });
    await client.release(a.lease.leaseId, { owner: 'w1' });
    expect((await client.listLeases()).leases.map((l) => l.leaseId)).toEqual([b.lease.leaseId]);
    expect((await client.listLeases({ state: 'ALL' })).leases).toHaveLength(2);
    expect(
      (await client.listLeases({ state: 'RELEASED', owner: 'w1' })).leases.map((l) => l.leaseId),
    ).toEqual([a.lease.leaseId]);
    const bad = await fetch(`${ts.url}/v1/leases?state=BOGUS`);
    expect(bad.status).toBe(400);
    const text = await client.metrics();
    expect(text).toMatch(/testlease_pool_resources\{pool="buyers",state="LEASED"\} \d/);
    expect(text).toMatch(/testlease_acquisitions_total\{pool="buyers"\} [23]/);
    expect(text).toMatch(/testlease_releases_total\{pool="buyers"\} 1/);
    expect(text).toMatch(/testlease_info\{schema_version="2"\} 1/);
    expect((await fetch(`${ts.url}/metrics`)).headers.get('content-type')).toMatch(/text\/plain/);
  });

  it('pool-restricted tokens cannot reach other pools over HTTP, and whoami shows the restriction', async () => {
    ts = await startTestServer({
      configInput: buyersConfig({
        auth: {
          tokens: [
            ...TOKENS.tokens,
            {
              name: 'buyers-only',
              token: 'env:TOKEN_BUYERS',
              scopes: ['lease:read', 'lease:write', 'pool:read'],
              pools: ['buyers'],
            },
          ],
        },
        pools: { ...(buyersConfig().pools as object), admins: { resources: [{ id: 'admin-01' }] } },
      }),
      secrets: { ...SECRETS, TOKEN_BUYERS: 'buyers-only-token-0123456789abcdef' },
    });
    const restricted = ts.client({ token: 'buyers-only-token-0123456789abcdef' });
    expect((await restricted.whoami()).pools).toEqual(['buyers']);
    expect((await restricted.listPools()).map((p) => p.name)).toEqual(['buyers']);
    const err = await expectError<TestLeaseError>(
      restricted.acquire({ pool: 'admins', owner: 'x' }),
    );
    expect(err.code).toBe('FORBIDDEN');
    expect(err.details?.allowedPools).toEqual(['buyers']);
    const admin = ts.client({ token: SECRETS.TOKEN_ADMIN });
    const lease = await admin.acquire({ pool: 'admins', owner: 'ops' });
    expect((await expectError<TestLeaseError>(restricted.getLease(lease.lease.leaseId))).code).toBe(
      'FORBIDDEN',
    );
    expect((await expectError<TestLeaseError>(restricted.getResource('admin-01'))).code).toBe(
      'FORBIDDEN',
    );
    expect((await restricted.listLeases({ state: 'ALL' })).leases).toEqual([]);
  });

  it('reloads configuration from the file via POST /v1/config/reload, including tokens, without dropping leases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'testlease-reload-'));
    const path = join(dir, 'testlease.yml');
    const write = (extraResources: string, extraToken = '') =>
      writeFileSync(
        path,
        `server: { host: 127.0.0.1, port: 0, db: ':memory:', logLevel: silent }\nauth:\n  tokens:\n    - { name: admin, token: env:TOKEN_ADMIN, scopes: [lease:read, lease:write, lease:admin, pool:read, resource:admin, secrets:resolve] }\n    - { name: ci, token: env:TOKEN_CI, scopes: [lease:read, lease:write, pool:read] }\n${extraToken}pools:\n  buyers:\n    defaultTtl: 10m\n    resources:\n      - { id: buyer-01, tags: { region: nl }, secrets: { password: env:BUYER_01_PASSWORD } }\n${extraResources}`,
      );
    write('');
    const env = { ...SECRETS, TOKEN_NEW: 'new-token-value-0123456789abcdef' };
    const loader = () => loadRuntimeConfig({ path, env });
    const engine: TestLeaseEngine = await createTestLease({
      config: loader().config,
      dbPath: ':memory:',
      logger: noopLogger,
      secretResolvers: [new EnvSecretResolver(env)],
      version: 'test',
      authMode: 'token',
      configLoader: loader,
      onReload: async () => server.reloadAuth(),
    });
    const server: RunningServer = await startServer({ engine, logger: noopLogger, port: 0 });
    try {
      const admin = new TestLeaseClient({
        baseUrl: server.url,
        token: SECRETS.TOKEN_ADMIN,
        owner: 'ops',
      });
      const ci = new TestLeaseClient({
        baseUrl: server.url,
        token: SECRETS.TOKEN_CI,
        owner: 'ci-w1',
      });
      const held = await ci.acquire({ pool: 'buyers', owner: 'ci-w1' });
      const waiter = ci.acquire({ pool: 'buyers', owner: 'ci-w2', waitTimeoutMs: 10_000 });
      await waitFor(() => engine.service.waitingCount === 1);

      // ci lacks resource:admin
      expect((await expectError<TestLeaseError>(ci.reloadConfig())).code).toBe('FORBIDDEN');

      // Add a resource and a token; the waiter must be served by the new resource.
      write(
        '      - { id: buyer-02, tags: { region: be }, secrets: { password: env:BUYER_02_PASSWORD } }\n',
        '    - { name: newbie, token: env:TOKEN_NEW, scopes: [pool:read] }\n',
      );
      const result = await admin.reloadConfig();
      expect(result.registered).toEqual(['buyer-02']);
      expect(result.reloads).toBe(1);
      const served = await waiter;
      expect(served.lease.resourceId).toBe('buyer-02');
      expect((await ci.getLease(held.lease.leaseId)).state).toBe('ACTIVE');
      const newbie = new TestLeaseClient({
        baseUrl: server.url,
        token: 'new-token-value-0123456789abcdef',
      });
      expect((await newbie.whoami()).principal).toBe('newbie');
      expect((await admin.health()).config.reloads).toBe(1);

      // Invalid file: rejected, nothing changes.
      writeFileSync(path, 'pools:\n  buyers:\n    resources: [{ id: dup }, { id: dup }]\n');
      const err = await expectError<TestLeaseError>(admin.reloadConfig());
      expect(err.code).toBe('CONFIG_INVALID');
      expect(err.message).toMatch(/defined twice/);
      expect((await admin.getPool('buyers')).counts.total).toBe(2);
      expect((await newbie.whoami()).principal).toBe('newbie');
    } finally {
      await server.close({ timeoutMs: 1000 });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a waiting client survives a server restart on the same port (retry with the same clientRequestId)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'testlease-restart-'));
    const dbPath = join(dir, 'tl.db');
    const cfg = () =>
      validateConfig(
        {
          server: { host: '127.0.0.1', port: 0, db: dbPath, logLevel: 'silent' },
          pools: { p: { defaultTtl: '10m', resources: [{ id: 'only' }] } },
        },
        '<t>',
      ).config;
    const boot = async (port: number) => {
      const engine = await createTestLease({
        config: cfg(),
        dbPath,
        logger: noopLogger,
        version: 'test',
      });
      const server = await startServer({ engine, logger: noopLogger, port });
      return { engine, server };
    };
    let { engine, server } = await boot(0);
    const port = server.port;
    try {
      const holder = new TestLeaseClient({ baseUrl: server.url, owner: 'holder', retries: 0 });
      const held = await holder.acquire({ pool: 'p', owner: 'holder' });
      const waiterClient = new TestLeaseClient({
        baseUrl: server.url,
        owner: 'waiter',
        requestTimeoutMs: 5_000,
      });
      const waiting = waiterClient.acquire({
        pool: 'p',
        owner: 'waiter',
        clientRequestId: 'waiter-1',
        waitTimeoutMs: 20_000,
      });
      await waitFor(() => engine.service.waitingCount === 1);

      await server.close({ timeoutMs: 500 }); // waiter gets SERVER_SHUTTING_DOWN and starts retrying
      await sleep(700); // server is down for a while: retries hit ECONNREFUSED
      ({ engine, server } = await boot(port));
      await waitFor(() => engine.service.waitingCount === 1, 10_000); // the retry re-queued on the new server
      await new TestLeaseClient({ baseUrl: server.url, owner: 'holder' }).release(
        held.lease.leaseId,
        { owner: 'holder' },
      );
      const res = await waiting;
      expect(res.lease.resourceId).toBe('only');
      expect(res.lease.owner).toBe('waiter');
      expect(engine.service.getPool('p').counts.leased).toBe(1);
    } finally {
      await server.close({ timeoutMs: 1000 });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
