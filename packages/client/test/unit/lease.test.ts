import { describe, expect, it, vi } from 'vitest';
import { TestLeaseError, type LeaseView, type RenewResponse } from '@testlease/protocol';
import { Lease, requireSecret } from '../../src/lease.js';
import type { TestLeaseClient } from '../../src/client.js';

function view(overrides: Partial<LeaseView> = {}): LeaseView {
  return {
    leaseId: 'lease_1',
    resourceId: 'r1',
    pool: 'p',
    owner: 'o',
    principal: 'local',
    resource: { id: 'r1', pool: 'p', tags: { region: 'nl' }, metadata: { email: 'e@x' }, secretKeys: ['password'] },
    state: 'ACTIVE',
    ttlMs: 3000,
    createdAt: 1_000,
    expiresAt: 4_000,
    lastHeartbeatAt: 1_000,
    ...overrides,
  };
}

/** A fake client recording calls; only the methods Lease uses. */
function fakeClient(behaviour: { renew?: () => Promise<RenewResponse> } = {}) {
  const calls: string[] = [];
  const client = {
    renew: vi.fn(async (): Promise<RenewResponse> => {
      calls.push('renew');
      return behaviour.renew ? behaviour.renew() : { lease: view({ expiresAt: Date.now() + 3000, lastHeartbeatAt: Date.now() }) };
    }),
    release: vi.fn(async () => {
      calls.push('release');
      return { lease: view({ state: 'RELEASED', endReason: 'RELEASED', endedAt: 5_000 }), outcome: 'released' as const };
    }),
    quarantine: vi.fn(async () => {
      calls.push('quarantine');
      return { lease: view({ state: 'RELEASED', endReason: 'QUARANTINED', endedAt: 5_000 }), resource: {} as never };
    }),
    resolveSecrets: vi.fn(async () => {
      calls.push('secrets');
      return { leaseId: 'lease_1', resourceId: 'r1', secrets: { password: 'pw-value' } };
    }),
    getLease: vi.fn(async () => {
      calls.push('get');
      return view({ state: 'EXPIRED', endReason: 'EXPIRED', endedAt: 4_000 });
    }),
  };
  return { client: client as unknown as TestLeaseClient, calls, mocks: client };
}

describe('Lease handle', () => {
  it('exposes the snapshot and resolves secrets by name', async () => {
    const { client } = fakeClient();
    const lease = new Lease(client, view());
    expect(lease.metadata.email).toBe('e@x');
    expect(lease.tags.region).toBe('nl');
    expect(lease.resource.secretKeys).toEqual(['password']);
    expect(await lease.secret('password')).toBe('pw-value');
    await expect(lease.secret('nope')).rejects.toThrow(/no secret named "nope". Available: password/);
  });

  it('heartbeat renews on the interval, never overlaps, and stops on release', async () => {
    vi.useFakeTimers();
    try {
      let pending: (() => void) | null = null;
      const { client, mocks } = fakeClient({
        renew: () =>
          new Promise((resolve) => {
            pending = () => resolve({ lease: view({ expiresAt: 9_000 }) });
          }),
      });
      const lease = new Lease(client, view());
      lease.startHeartbeat({ intervalMs: 100 });
      expect(lease.heartbeat.running).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(mocks.renew).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(300); // renew still in flight: no overlapping calls
      expect(mocks.renew).toHaveBeenCalledTimes(1);
      pending!();
      await vi.advanceTimersByTimeAsync(0);
      expect(lease.heartbeat.renewals).toBe(1);
      expect(lease.heartbeat.healthy).toBe(true);
      expect(lease.expiresAt).toBe(9_000);
      await lease.release();
      expect(lease.heartbeat.running).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.renew).toHaveBeenCalledTimes(1);
      expect(lease.state).toBe('RELEASED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the heartbeat on terminal errors and records them in evidence', async () => {
    vi.useFakeTimers();
    try {
      const errors: string[] = [];
      const { client } = fakeClient({
        renew: async () => {
          throw new TestLeaseError('LEASE_EXPIRED', 'gone');
        },
      });
      const lease = new Lease(client, view());
      lease.startHeartbeat({ intervalMs: 50, onError: (e) => errors.push((e as TestLeaseError).code) });
      await vi.advanceTimersByTimeAsync(60);
      expect(errors).toEqual(['LEASE_EXPIRED']);
      expect(lease.heartbeat.running).toBe(false);
      expect(lease.heartbeat.healthy).toBe(false);
      expect(lease.heartbeat.failures).toBe(1);
      expect(lease.state).toBe('EXPIRED');
      const ev = lease.evidence();
      expect(ev).toMatchObject({ leaseId: 'lease_1', resourceId: 'r1', state: 'EXPIRED', expiredDuringUse: true, heartbeat: { failures: 1, lastError: { code: 'LEASE_EXPIRED' } } });
      expect(JSON.stringify(ev)).not.toContain('pw-value');
      expect(JSON.stringify(ev)).not.toContain('secretKeys'); // evidence has no secret names either
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps retrying on transient errors and recovers', async () => {
    vi.useFakeTimers();
    try {
      let fail = true;
      const { client } = fakeClient({
        renew: async () => {
          if (fail) throw new TestLeaseError('UNAVAILABLE', 'network');
          return { lease: view({ expiresAt: 8_000 }) };
        },
      });
      const lease = new Lease(client, view());
      lease.startHeartbeat({ intervalMs: 50 });
      await vi.advanceTimersByTimeAsync(60);
      expect(lease.heartbeat.healthy).toBe(false);
      expect(lease.heartbeat.running).toBe(true);
      fail = false;
      await vi.advanceTimersByTimeAsync(60);
      expect(lease.heartbeat.healthy).toBe(true);
      expect(lease.heartbeat.renewals).toBe(1);
      lease.stopHeartbeat();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refresh detects expiry and quarantine records the reason', async () => {
    const { client, calls } = fakeClient();
    const lease = new Lease(client, view());
    lease.startHeartbeat({ intervalMs: 60_000 });
    const v = await lease.refresh();
    expect(v.state).toBe('EXPIRED');
    expect(lease.heartbeat.running).toBe(false);
    expect(lease.evidence().expiredDuringUse).toBe(true);

    const other = new Lease(client, view({ leaseId: 'lease_2' }));
    await other.quarantine('locked');
    expect(other.state).toBe('RELEASED');
    expect(other.evidence()).toMatchObject({ endReason: 'QUARANTINED', quarantineReason: 'locked' });
    expect(calls).toContain('quarantine');
  });

  it('requireSecret explains what is available', () => {
    expect(requireSecret({ a: '1' }, 'a', ['a'], 'r')).toBe('1');
    expect(() => requireSecret({}, 'b', [], 'r')).toThrow(/Available: none/);
  });
});
