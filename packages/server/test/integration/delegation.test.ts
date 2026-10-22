import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestLease,
  EnvSecretResolver,
  loadRuntimeConfig,
  noopLogger,
  type Logger,
  type TestLeaseEngine,
} from '@testlease/core';
import { TestLeaseClient } from '@testlease/client';
import type { TestLeaseError } from '@testlease/protocol';
import { startServer, type RunningServer } from '../../src/index.js';
import {
  buyersConfig,
  expectError,
  SECRETS,
  startTestServer,
  type TestServer,
} from '../helpers.js';

// Agent token acquires (no secrets:resolve); runner token has secrets:resolve + delegateFor: [agent].

const LOCAL_SECRETS = {
  ...SECRETS,
  TOKEN_AGENT: 'agent-token-value-0123456789abcdef',
  TOKEN_RUNNER: 'runner-token-value-0123456789abcdef',
  TOKEN_STRANGER: 'stranger-token-value-0123456789abcdef',
  TOKEN_SCOPED_RUNNER: 'scoped-runner-token-0123456789abcdef',
};

const AGENT_OWNER = 'agent:alpha/task-1';

const DELEGATION_TOKENS = {
  tokens: [
    { name: 'agent', token: 'env:TOKEN_AGENT', scopes: ['lease:read', 'lease:write', 'pool:read'] },
    {
      name: 'runner',
      token: 'env:TOKEN_RUNNER',
      scopes: ['lease:read', 'lease:write', 'secrets:resolve'],
      delegateFor: ['agent'],
    },
    {
      name: 'stranger',
      token: 'env:TOKEN_STRANGER',
      scopes: ['lease:read', 'lease:write', 'secrets:resolve'],
    },
    {
      name: 'scoped-runner',
      token: 'env:TOKEN_SCOPED_RUNNER',
      scopes: ['lease:read', 'lease:write', 'secrets:resolve'],
      pools: ['buyers'],
      delegateFor: ['agent'],
    },
  ],
};

function delegationConfig(): Record<string, unknown> {
  const base = buyersConfig({ auth: DELEGATION_TOKENS });
  const pools = base.pools as Record<string, unknown>;
  pools.admins = {
    defaultTtl: '5m',
    resources: [{ id: 'admin-01', secrets: { password: 'env:BUYER_03_PASSWORD' } }],
  };
  return base;
}

function assertNoSecrets(payload: unknown): void {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const secret of Object.values(LOCAL_SECRETS)) expect(text).not.toContain(secret);
}

function capturingLogger(lines: string[]): Logger {
  const record = (obj: Record<string, unknown>, msg?: string): void => {
    lines.push(`${JSON.stringify(obj)} ${msg ?? ''}`);
  };
  return { trace: record, debug: record, info: record, warn: record, error: record };
}

describe('token delegation over HTTP', () => {
  let ts: TestServer;
  let logLines: string[];
  let leaseId: string;

  const client = (tokenValue: string, owner = AGENT_OWNER) =>
    ts.client({ token: tokenValue, owner });

  beforeEach(async () => {
    logLines = [];
    ts = await startTestServer({
      configInput: delegationConfig(),
      secrets: LOCAL_SECRETS,
      logger: capturingLogger(logLines),
    });
    const res = await client(LOCAL_SECRETS.TOKEN_AGENT).acquire({
      pool: 'buyers',
      owner: AGENT_OWNER,
      tags: { region: 'nl' },
    });
    leaseId = res.lease.leaseId;
  });

  afterEach(async () => {
    await ts.close();
  });

  it('runner token resolves secrets for a lease acquired by the agent token (200)', async () => {
    const res = await client(LOCAL_SECRETS.TOKEN_RUNNER).resolveSecrets(leaseId, {
      owner: AGENT_OWNER,
    });
    expect(res).toEqual({
      leaseId,
      resourceId: 'buyer-01',
      secrets: { password: SECRETS.BUYER_01_PASSWORD },
    });
  });

  it('agent token without secrets:resolve gets 403 on /v1/leases/:id/secrets', async () => {
    const err = await expectError<TestLeaseError>(
      client(LOCAL_SECRETS.TOKEN_AGENT).resolveSecrets(leaseId, { owner: AGENT_OWNER }),
    );
    expect(err).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    assertNoSecrets(err);
  });

  it('runner token renews and releases the agent lease', async () => {
    const runner = client(LOCAL_SECRETS.TOKEN_RUNNER);
    const renewed = await runner.renew(leaseId, { owner: AGENT_OWNER, ttlMs: 20 * 60_000 });
    expect(renewed.lease.renewCount).toBe(1);
    const released = await runner.release(leaseId, { owner: AGENT_OWNER });
    expect(released.outcome).toBe('released');
    const events = (await client(LOCAL_SECRETS.TOKEN_AGENT).listLeaseEvents(leaseId)).events;
    expect(events.find((e) => e.type === 'LEASE_RELEASED')?.details).toMatchObject({
      principal: 'runner',
      onBehalfOf: 'agent',
    });
  });

  it('runner token cannot quarantine the agent lease', async () => {
    const err = await expectError<TestLeaseError>(
      client(LOCAL_SECRETS.TOKEN_RUNNER).quarantine(leaseId, {
        owner: AGENT_OWNER,
        reason: 'looks contaminated',
      }),
    );
    expect(err).toMatchObject({ code: 'LEASE_OWNERSHIP_MISMATCH', status: 403 });
    expect((await client(LOCAL_SECRETS.TOKEN_AGENT).getLease(leaseId)).state).toBe('ACTIVE');
  });

  it('runner token cannot force-release without lease:admin', async () => {
    const err = await expectError<TestLeaseError>(
      client(LOCAL_SECRETS.TOKEN_RUNNER).release(leaseId, { owner: 'runner-host', force: true }),
    );
    expect(err).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect((await client(LOCAL_SECRETS.TOKEN_AGENT).getLease(leaseId)).state).toBe('ACTIVE');
  });

  it('a token without delegateFor for the agent gets LEASE_OWNERSHIP_MISMATCH', async () => {
    const err = await expectError<TestLeaseError>(
      client(LOCAL_SECRETS.TOKEN_STRANGER).resolveSecrets(leaseId, { owner: AGENT_OWNER }),
    );
    expect(err).toMatchObject({ code: 'LEASE_OWNERSHIP_MISMATCH', status: 403 });
    expect(err.details?.mismatch).toBe('principal');
    assertNoSecrets(err);
  });

  it('pool-scoped runner token gets 403 for a lease in a pool outside its pools', async () => {
    const admins = await client(LOCAL_SECRETS.TOKEN_AGENT).acquire({
      pool: 'admins',
      owner: AGENT_OWNER,
    });
    const scoped = client(LOCAL_SECRETS.TOKEN_SCOPED_RUNNER);
    const err = await expectError<TestLeaseError>(
      scoped.resolveSecrets(admins.lease.leaseId, { owner: AGENT_OWNER }),
    );
    expect(err).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    assertNoSecrets(err);
    // Inside its pools the same token works.
    expect((await scoped.resolveSecrets(leaseId, { owner: AGENT_OWNER })).secrets.password).toBe(
      SECRETS.BUYER_01_PASSWORD,
    );
  });

  it('no response or log line contains a secret value or token', async () => {
    const runner = client(LOCAL_SECRETS.TOKEN_RUNNER);
    const resolved = await runner.resolveSecrets(leaseId, { owner: AGENT_OWNER });
    expect(resolved.secrets.password).toBe(SECRETS.BUYER_01_PASSWORD); // the one intended exposure
    const responses = [
      await runner.renew(leaseId, { owner: AGENT_OWNER, ttlMs: 20 * 60_000 }),
      await runner.getLease(leaseId),
      await client(LOCAL_SECRETS.TOKEN_AGENT).listLeaseEvents(leaseId),
      await runner.release(leaseId, { owner: AGENT_OWNER }),
    ];
    assertNoSecrets(responses);
    expect(logLines.length).toBeGreaterThan(0);
    assertNoSecrets(logLines.join('\n'));
  });
});

describe('token delegation and config reload', () => {
  it('delegateFor added by a reload takes effect for the next request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'testlease-delegation-'));
    const path = join(dir, 'testlease.yml');
    const write = (runnerExtra: string) =>
      writeFileSync(
        path,
        `server: { host: 127.0.0.1, port: 0, db: ':memory:', logLevel: silent }\nauth:\n  tokens:\n    - { name: admin, token: env:TOKEN_ADMIN, scopes: [lease:read, lease:write, lease:admin, pool:read, resource:admin] }\n    - { name: agent, token: env:TOKEN_AGENT, scopes: [lease:read, lease:write, pool:read] }\n    - { name: runner, token: env:TOKEN_RUNNER, scopes: [lease:read, lease:write, secrets:resolve]${runnerExtra} }\npools:\n  buyers:\n    defaultTtl: 10m\n    resources:\n      - { id: buyer-01, secrets: { password: env:BUYER_01_PASSWORD } }\n`,
      );
    write('');
    const env = { ...LOCAL_SECRETS };
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
      const mk = (tokenValue: string) =>
        new TestLeaseClient({ baseUrl: server.url, token: tokenValue, owner: AGENT_OWNER });
      const agent = mk(LOCAL_SECRETS.TOKEN_AGENT);
      const runner = mk(LOCAL_SECRETS.TOKEN_RUNNER);
      const { lease } = await agent.acquire({ pool: 'buyers', owner: AGENT_OWNER });

      const before = await expectError<TestLeaseError>(
        runner.resolveSecrets(lease.leaseId, { owner: AGENT_OWNER }),
      );
      expect(before.code).toBe('LEASE_OWNERSHIP_MISMATCH');

      write(', delegateFor: [agent]');
      await mk(SECRETS.TOKEN_ADMIN!).reloadConfig();

      const after = await runner.resolveSecrets(lease.leaseId, { owner: AGENT_OWNER });
      expect(after.secrets.password).toBe(SECRETS.BUYER_01_PASSWORD);
      // The lease itself was not touched by the reload.
      expect((await agent.getLease(lease.leaseId)).state).toBe('ACTIVE');
    } finally {
      await server.close({ timeoutMs: 1000 });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
