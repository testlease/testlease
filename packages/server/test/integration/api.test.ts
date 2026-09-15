import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ErrorBody, TestLeaseError } from '@testlease/protocol';
import {
  buyersConfig,
  expectError,
  SECRETS,
  startTestServer,
  TOKENS,
  type TestServer,
} from '../helpers.js';

describe('REST API (insecure-local mode)', () => {
  let ts: TestServer;
  beforeEach(async () => {
    ts = await startTestServer();
  });
  afterEach(() => ts.close());

  it('serves health without auth and whoami as local', async () => {
    const health = await ts.client().health();
    expect(health).toMatchObject({
      status: 'ok',
      name: 'testlease',
      auth: { mode: 'insecure-local' },
      db: { schemaVersion: 1 },
    });
    const who = await ts.client().whoami();
    expect(who.principal).toBe('local');
    expect(who.scopes).toContain('secrets:resolve');
  });

  it('acquire → get → renew → release round trip with evidence', async () => {
    const client = ts.client({ owner: 'gha-1/chromium/worker-1' });
    const res = await client.acquire({
      pool: 'buyers',
      owner: 'gha-1/chromium/worker-1',
      tags: { region: 'nl' },
      purpose: 'smoke',
    });
    expect(res.reused).toBe(false);
    expect(res.lease.resource.metadata.email).toBe('buyer01@example.test');
    expect(res.lease.principal).toBe('local');
    expect(res.lease.clientRequestId).toMatch(/^tlc-/); // client generated an idempotency key
    expect(JSON.stringify(res)).not.toContain('hunter2');

    const fetched = await client.getLease(res.lease.leaseId);
    expect(fetched.state).toBe('ACTIVE');
    const renewed = await client.renew(res.lease.leaseId, { owner: 'gha-1/chromium/worker-1' });
    expect(renewed.lease.expiresAt).toBeGreaterThanOrEqual(res.lease.expiresAt);

    const pool = await client.getPool('buyers');
    expect(pool.counts).toMatchObject({ available: 2, leased: 1 });
    expect(pool.resources.find((r) => r.id === 'buyer-01')!.activeLease?.owner).toBe(
      'gha-1/chromium/worker-1',
    );

    const released = await client.release(res.lease.leaseId, { owner: 'gha-1/chromium/worker-1' });
    expect(released.outcome).toBe('released');
    expect(
      (await client.release(res.lease.leaseId, { owner: 'gha-1/chromium/worker-1' })).outcome,
    ).toBe('already_released');

    const events = await client.listLeaseEvents(res.lease.leaseId);
    expect(events.events.map((e) => e.type)).toEqual([
      'LEASE_ACQUIRED',
      'LEASE_RENEWED',
      'LEASE_RELEASED',
    ]);
  });

  it('returns structured errors with stable codes', async () => {
    const client = ts.client();
    const notFound = await expectError<TestLeaseError>(client.getLease('lease_nope'));
    expect(notFound.code).toBe('LEASE_NOT_FOUND');
    expect(notFound.status).toBe(404);

    const badPool = await expectError<TestLeaseError>(client.acquire({ pool: 'nope', owner: 'x' }));
    expect(badPool.code).toBe('POOL_NOT_FOUND');

    const invalid = await expectError<TestLeaseError>(
      client.acquire({ pool: 'buyers', owner: 'has space' }),
    );
    expect(invalid.code).toBe('INVALID_REQUEST');
    expect(invalid.details?.issues).toBeDefined();

    const raw = await fetch(`${ts.url}/v1/leases/acquire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(raw.status).toBe(400);
    expect(((await raw.json()) as ErrorBody).error.code).toBe('INVALID_REQUEST');

    const route = await fetch(`${ts.url}/v1/nothing`);
    expect(route.status).toBe(404);
    expect(((await route.json()) as ErrorBody).error.code).toBe('NOT_FOUND');

    const big = await fetch(`${ts.url}/v1/leases/acquire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pool: 'buyers', owner: 'x', purpose: 'y'.repeat(70_000) }),
    });
    expect(big.status).toBe(413);
  });

  it('POOL_EXHAUSTED, NO_MATCHING_RESOURCE and ACQUIRE_TIMEOUT are distinct over HTTP', async () => {
    const client = ts.client();
    await client.acquire({ pool: 'buyers', owner: 'a', tags: { region: 'be' } });
    const exhausted = await expectError<TestLeaseError>(
      client.acquire({ pool: 'buyers', owner: 'b', tags: { region: 'be' } }),
    );
    expect(exhausted.code).toBe('POOL_EXHAUSTED');
    expect(exhausted.message).toMatch(/buyer-03\s+LEASED\s+owner=a/);
    const none = await expectError<TestLeaseError>(
      client.acquire({ pool: 'buyers', owner: 'b', tags: { region: 'de' } }),
    );
    expect(none.code).toBe('NO_MATCHING_RESOURCE');
    const timeout = await expectError<TestLeaseError>(
      client.acquire({ pool: 'buyers', owner: 'b', tags: { region: 'be' }, waitTimeoutMs: 200 }),
    );
    expect(timeout.code).toBe('ACQUIRE_TIMEOUT');
    expect(timeout.details?.waitedMs).toBeGreaterThanOrEqual(190);
  });

  it('DELETE /v1/leases/:id is an alias for release', async () => {
    const client = ts.client();
    const res = await client.acquire({ pool: 'buyers', owner: 'a' });
    const del = await fetch(`${ts.url}/v1/leases/${res.lease.leaseId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'a' }),
    });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { outcome: string }).outcome).toBe('released');
  });

  it('quarantine via lease, restore via resource, secrets via lease', async () => {
    const client = ts.client();
    const res = await client.acquire({ pool: 'buyers', owner: 'a', tags: { region: 'be' } });
    const secrets = await client.resolveSecrets(res.lease.leaseId, { owner: 'a' });
    expect(secrets.secrets).toEqual({ password: SECRETS.BUYER_03_PASSWORD });
    const wrongOwner = await expectError<TestLeaseError>(
      client.resolveSecrets(res.lease.leaseId, { owner: 'b' }),
    );
    expect(wrongOwner.code).toBe('LEASE_OWNERSHIP_MISMATCH');

    const q = await client.quarantine(res.lease.leaseId, { owner: 'a', reason: 'account locked' });
    expect(q.resource.state).toBe('QUARANTINED');
    expect((await client.getResource('buyer-03')).quarantine?.reason).toBe('account locked');
    const restored = await client.restoreResource('buyer-03');
    expect(restored.resource.state).toBe('AVAILABLE');
    const events = await client.listResourceEvents('buyer-03');
    expect(events.events.map((e) => e.type)).toContain('RESOURCE_RESTORED');
  });
});

describe('REST API (token mode)', () => {
  let ts: TestServer;
  beforeEach(async () => {
    ts = await startTestServer({ configInput: buyersConfig({ auth: TOKENS }) });
  });
  afterEach(() => ts.close());

  it('rejects missing and wrong tokens without leaking which token exists', async () => {
    const noToken = await expectError<TestLeaseError>(ts.client().listPools());
    expect(noToken.code).toBe('UNAUTHORIZED');
    const wrong = await expectError<TestLeaseError>(
      ts.client({ token: 'ci-token-value-0123456789abcdeX' }).listPools(),
    );
    expect(wrong.code).toBe('UNAUTHORIZED');
    expect(wrong.message).not.toContain('ci');
    // health stays public
    expect((await ts.client().health()).auth.mode).toBe('token');
  });

  it('derives the principal from the token and enforces scopes', async () => {
    const ci = ts.client({ token: SECRETS.TOKEN_CI });
    const reader = ts.client({ token: SECRETS.TOKEN_READER });
    const admin = ts.client({ token: SECRETS.TOKEN_ADMIN });

    expect((await ci.whoami()).principal).toBe('ci');
    const res = await ci.acquire({ pool: 'buyers', owner: 'gha-1/w1' });
    expect(res.lease.principal).toBe('ci');

    const forbidden = await expectError<TestLeaseError>(
      reader.acquire({ pool: 'buyers', owner: 'r' }),
    );
    expect(forbidden.code).toBe('FORBIDDEN');
    expect(forbidden.details?.requiredScope).toBe('lease:write');
    expect((await reader.getLease(res.lease.leaseId)).owner).toBe('gha-1/w1');

    // Owner string alone is not proof of ownership: a different principal is refused.
    const otherPrincipal = ts.client({ token: SECRETS.TOKEN_ADMIN });
    const mismatch = await expectError<TestLeaseError>(
      otherPrincipal.release(res.lease.leaseId, { owner: 'gha-1/w1' }),
    );
    expect(mismatch.code).toBe('LEASE_OWNERSHIP_MISMATCH');
    expect(mismatch.details?.mismatch).toBe('principal');

    // force requires lease:admin
    const ciForce = await expectError<TestLeaseError>(
      ci.release(res.lease.leaseId, { owner: 'someone-else', force: true }),
    );
    expect(ciForce.code).toBe('FORBIDDEN');
    expect(ciForce.details?.requiredScope).toBe('lease:admin');
    const forced = await admin.release(res.lease.leaseId, { owner: 'ops', force: true });
    expect(forced.outcome).toBe('released');
    expect(forced.lease.endReason).toBe('FORCE_RELEASED');

    // secrets:resolve is a separate scope
    const res2 = await admin.acquire({ pool: 'buyers', owner: 'ops' });
    const noSecrets = await expectError<TestLeaseError>(
      reader.resolveSecrets(res2.lease.leaseId, { owner: 'ops' }),
    );
    expect(noSecrets.code).toBe('FORBIDDEN');
    // resource:admin
    const noAdmin = await expectError<TestLeaseError>(ci.restoreResource('buyer-01'));
    expect(noAdmin.code).toBe('FORBIDDEN');
  });
});
