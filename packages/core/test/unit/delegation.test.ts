import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LeaseEvent, TestLeaseError } from '@testlease/protocol';
import { ConfigError, validateConfig } from '../../src/config/load.js';
import type { PrincipalOptions } from '../../src/domain/local-api.js';
import type { TestLeaseEngine } from '../../src/testlease.js';
import { baseConfigInput, expectError, makeEngine, TEST_SECRETS } from '../helpers.js';

// Token delegation (`delegateFor`, ADR-0016): a runner token may act for another principal's
// lease on resolveSecrets, renew and release only. Owner must still match.

// Test-only declaration of the forthcoming option; never supplies a fallback.
type DelegatingOptions = PrincipalOptions & { delegateFor?: ReadonlySet<string> };

const AGENT_OWNER = 'agent:alpha/task-1';

function withTokens(tokens: unknown[]): Record<string, unknown> {
  return { ...baseConfigInput(), auth: { tokens } };
}

function token(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, token: `env:TOKEN_${name.toUpperCase()}`, ...extra };
}

function configProblems(input: unknown): string[] {
  try {
    validateConfig(input, '<test>');
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).problems;
  }
  throw new Error('expected validateConfig to throw');
}

function assertNoSecrets(payload: unknown): void {
  const text = JSON.stringify(payload);
  for (const secret of Object.values(TEST_SECRETS)) expect(text).not.toContain(secret);
}

describe('config: tokens[].delegateFor', () => {
  it('accepts delegateFor naming another configured token', () => {
    const { config } = validateConfig(
      withTokens([token('agent'), token('runner', { delegateFor: ['agent'] })]),
      '<test>',
    );
    const runner = config.auth.tokens.find((t) => t.name === 'runner') as
      { delegateFor?: string[] } | undefined;
    expect(runner?.delegateFor).toEqual(['agent']);
  });

  it('rejects a delegateFor target that is not a configured token, with a fix-it message', () => {
    const problems = configProblems(
      withTokens([token('agent'), token('runner', { delegateFor: ['ghost'] })]),
    );
    expect(problems).toEqual([
      expect.stringMatching(/auth\.tokens\[runner\]\.delegateFor.*"ghost".*not a configured token/),
    ]);
  });

  it('rejects a token delegating for itself', () => {
    const problems = configProblems(withTokens([token('runner', { delegateFor: ['runner'] })]));
    expect(problems).toEqual([
      expect.stringMatching(/auth\.tokens\[runner\]\.delegateFor.*itself/),
    ]);
  });

  it('rejects a delegation chain (a target that itself has delegateFor)', () => {
    const problems = configProblems(
      withTokens([
        token('agent'),
        token('runner', { delegateFor: ['agent'] }),
        token('outer', { delegateFor: ['runner'] }),
      ]),
    );
    expect(problems).toEqual([
      expect.stringMatching(/auth\.tokens\[outer\]\.delegateFor.*"runner".*not transitive/),
    ]);
  });

  it('rejects an empty delegateFor list', () => {
    expect(() =>
      validateConfig(withTokens([token('agent'), token('runner', { delegateFor: [] })]), '<test>'),
    ).toThrow(ConfigError);
  });
});

describe('LeaseService: delegated ownership', () => {
  let engine: TestLeaseEngine;
  let leaseId: string;

  const runnerOptions: DelegatingOptions = { delegateFor: new Set(['agent']) };
  const runner = () => engine.api.as('runner', runnerOptions);
  const agent = () => engine.api.as('agent');

  beforeEach(async () => {
    engine = await makeEngine();
    const res = await agent().acquire({
      pool: 'buyers',
      owner: AGENT_OWNER,
      tags: { region: 'nl' },
    });
    leaseId = res.lease.leaseId;
  });

  afterEach(() => engine.close());

  it('secretRefsForLease succeeds for a delegate of the lease principal with the lease owner', async () => {
    const res = await runner().resolveSecrets(leaseId, { owner: AGENT_OWNER });
    expect(res.leaseId).toBe(leaseId);
    expect(res.secrets).toEqual({ password: TEST_SECRETS.BUYER_01_PASSWORD });
  });

  it('renew succeeds for a delegate of the lease principal', async () => {
    const res = await runner().renew(leaseId, { owner: AGENT_OWNER, ttlMs: 20 * 60_000 });
    expect(res.lease.state).toBe('ACTIVE');
    expect(res.lease.renewCount).toBe(1);
    expect(res.lease.principal).toBe('agent');
  });

  it('release succeeds for a delegate of the lease principal', async () => {
    const res = await runner().release(leaseId, { owner: AGENT_OWNER });
    expect(res.outcome).toBe('released');
    expect((await agent().getPool('buyers')).counts.leased).toBe(0);
  });

  it('quarantine rejects a delegate with LEASE_OWNERSHIP_MISMATCH (mismatch: principal)', async () => {
    const err = await expectError<TestLeaseError>(
      runner().quarantine(leaseId, { owner: AGENT_OWNER, reason: 'looks contaminated' }),
    );
    expect(err.code).toBe('LEASE_OWNERSHIP_MISMATCH');
    expect(err.details?.mismatch).toBe('principal');
    expect((await agent().getLease(leaseId)).state).toBe('ACTIVE');
    expect((await agent().getResource('buyer-01')).state).toBe('LEASED');
  });

  it('rejects a principal not listed in delegateFor with LEASE_OWNERSHIP_MISMATCH', async () => {
    const other: DelegatingOptions = { delegateFor: new Set(['someone-else']) };
    const err = await expectError<TestLeaseError>(
      engine.api.as('runner', other).resolveSecrets(leaseId, { owner: AGENT_OWNER }),
    );
    expect(err.code).toBe('LEASE_OWNERSHIP_MISMATCH');
    expect(err.details?.mismatch).toBe('principal');
    assertNoSecrets(err);
  });

  it('rejects a delegate presenting a different owner (mismatch: owner)', async () => {
    for (const call of [
      () => runner().resolveSecrets(leaseId, { owner: 'runner-host' }),
      () => runner().renew(leaseId, { owner: 'runner-host' }),
      () => runner().release(leaseId, { owner: 'runner-host' }),
    ]) {
      const err = await expectError<TestLeaseError>(call);
      expect(err.code).toBe('LEASE_OWNERSHIP_MISMATCH');
      expect(err.details?.mismatch).toBe('owner');
    }
    expect((await agent().getLease(leaseId)).state).toBe('ACTIVE');
  });

  it('delegation is not transitive: a delegate of a delegate is rejected', async () => {
    const outer: DelegatingOptions = { delegateFor: new Set(['runner']) };
    const err = await expectError<TestLeaseError>(
      engine.api.as('outer', outer).resolveSecrets(leaseId, { owner: AGENT_OWNER }),
    );
    expect(err.code).toBe('LEASE_OWNERSHIP_MISMATCH');
    expect(err.details?.mismatch).toBe('principal');
  });

  it('the lease principal itself still works unchanged (no regression)', async () => {
    expect((await agent().resolveSecrets(leaseId, { owner: AGENT_OWNER })).secrets).toEqual({
      password: TEST_SECRETS.BUYER_01_PASSWORD,
    });
    expect((await agent().release(leaseId, { owner: AGENT_OWNER })).outcome).toBe('released');
  });
});

describe('events: delegated actions', () => {
  let engine: TestLeaseEngine;
  let leaseId: string;

  const runnerOptions: DelegatingOptions = { delegateFor: new Set(['agent']) };
  const runner = () => engine.api.as('runner', runnerOptions);
  const agent = () => engine.api.as('agent');

  async function eventsOfType(type: string): Promise<LeaseEvent[]> {
    return (await agent().listLeaseEvents(leaseId)).events.filter((e) => e.type === type);
  }

  beforeEach(async () => {
    engine = await makeEngine();
    const res = await agent().acquire({
      pool: 'buyers',
      owner: AGENT_OWNER,
      tags: { region: 'nl' },
    });
    leaseId = res.lease.leaseId;
  });

  afterEach(() => engine.close());

  it('LEASE_SECRETS_RESOLVED by a delegate records principal=runner and onBehalfOf=lease principal', async () => {
    await runner().resolveSecrets(leaseId, { owner: AGENT_OWNER });
    const [event] = await eventsOfType('LEASE_SECRETS_RESOLVED');
    expect(event?.details).toMatchObject({
      secretKeys: ['password'],
      principal: 'runner',
      onBehalfOf: 'agent',
    });
  });

  it('LEASE_RENEWED / LEASE_RELEASED by a delegate record onBehalfOf', async () => {
    // A TTL change records LEASE_RENEWED even with history.recordRenewals off.
    await runner().renew(leaseId, { owner: AGENT_OWNER, ttlMs: 20 * 60_000 });
    await runner().release(leaseId, { owner: AGENT_OWNER });
    const [renewed] = await eventsOfType('LEASE_RENEWED');
    const [released] = await eventsOfType('LEASE_RELEASED');
    expect(renewed?.details).toMatchObject({ principal: 'runner', onBehalfOf: 'agent' });
    expect(released?.details).toMatchObject({ principal: 'runner', onBehalfOf: 'agent' });
  });

  it('non-delegated actions do not record onBehalfOf', async () => {
    await agent().resolveSecrets(leaseId, { owner: AGENT_OWNER });
    await agent().renew(leaseId, { owner: AGENT_OWNER, ttlMs: 20 * 60_000 });
    await agent().release(leaseId, { owner: AGENT_OWNER });
    const events = (await agent().listLeaseEvents(leaseId)).events;
    expect(events.length).toBeGreaterThanOrEqual(4);
    for (const e of events) expect(e.details ?? {}).not.toHaveProperty('onBehalfOf');
  });

  it('delegated events contain no secret values', async () => {
    await runner().resolveSecrets(leaseId, { owner: AGENT_OWNER });
    await runner().renew(leaseId, { owner: AGENT_OWNER, ttlMs: 20 * 60_000 });
    await runner().release(leaseId, { owner: AGENT_OWNER });
    assertNoSecrets(await agent().listLeaseEvents(leaseId));
  });
});
