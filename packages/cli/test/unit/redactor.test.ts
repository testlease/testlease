import { describe, expect, it } from 'vitest';
import { Redactor, buildLeaseEnv, envKey } from '../../src/commands/exec.js';
import { Lease } from '@testlease/client';

async function pump(redactor: Redactor, chunks: string[]): Promise<string> {
  let out = '';
  redactor.on('data', (d: Buffer) => (out += d.toString()));
  const done = new Promise<void>((resolve) => redactor.on('end', resolve));
  for (const c of chunks) redactor.write(c);
  redactor.end();
  await done;
  return out;
}

describe('Redactor', () => {
  const SECRET = 'cli-secret-one-value';

  it('redacts a secret contained in one chunk', async () => {
    expect(await pump(new Redactor({ password: SECRET }), [`leak: ${SECRET}\n`])).toBe(
      'leak: [REDACTED:password]\n',
    );
  });

  it('regression: redacts a secret whose occurrence straddles the emit/carry boundary', async () => {
    // Exactly the sequence that leaked before the fix: the first chunk ends inside the
    // hold-back window and the second chunk completes a *different* occurrence.
    const out = await pump(new Redactor({ password: SECRET }), [
      `leak attempt: ${SECRET}\n`,
      'again cli-secret-',
      'one-value tail\n',
    ]);
    expect(out).toBe('leak attempt: [REDACTED:password]\nagain [REDACTED:password] tail\n');
    expect(out).not.toContain(SECRET);
  });

  it('redacts secrets split byte-by-byte across chunks', async () => {
    const text = `a ${SECRET} b ${SECRET}`;
    const out = await pump(new Redactor({ password: SECRET }), text.split(''));
    expect(out).toBe('a [REDACTED:password] b [REDACTED:password]');
  });

  it('handles several secrets, longest first, and ignores very short values', async () => {
    const out = await pump(new Redactor({ a: 'longer-secret-value', b: 'longer', c: 'ab' }), [
      'x longer-secret-value y longer z ab',
    ]);
    expect(out).toBe('x [REDACTED:a] y [REDACTED:b] z ab');
  });

  it('passes text through when there are no secrets', async () => {
    expect(await pump(new Redactor({}), ['hello ', 'world'])).toBe('hello world');
  });
});

describe('lease environment', () => {
  it('builds prefixed variables for lease, tags, metadata and secrets', () => {
    const lease = new Lease({ renew: async () => ({}) } as never, {
      leaseId: 'lease_x',
      resourceId: 'buyer-01',
      pool: 'buyers',
      owner: 'o',
      principal: 'local',
      resource: {
        id: 'buyer-01',
        pool: 'buyers',
        tags: { region: 'nl', 'payment-method': 'ideal' },
        metadata: { email: 'e@x', slot: 3 },
        secretKeys: ['password'],
      },
      state: 'ACTIVE',
      ttlMs: 1000,
      createdAt: 0,
      expiresAt: 1000,
      lastHeartbeatAt: 0,
      renewCount: 0,
    });
    const env = buildLeaseEnv(lease, { password: 'pw' }, 'TESTLEASE', 'http://h');
    expect(env).toEqual({
      TESTLEASE_URL: 'http://h',
      TESTLEASE_LEASE_ID: 'lease_x',
      TESTLEASE_RESOURCE_ID: 'buyer-01',
      TESTLEASE_POOL: 'buyers',
      TESTLEASE_OWNER: 'o',
      TESTLEASE_EXPIRES_AT: '1970-01-01T00:00:01.000Z',
      TESTLEASE_TAG_REGION: 'nl',
      TESTLEASE_TAG_PAYMENT_METHOD: 'ideal',
      TESTLEASE_META_EMAIL: 'e@x',
      TESTLEASE_META_SLOT: '3',
      TESTLEASE_SECRET_PASSWORD: 'pw',
    });
    expect(envKey('TL', 'secret', 'api.key')).toBe('TL_SECRET_API_KEY');
  });
});
