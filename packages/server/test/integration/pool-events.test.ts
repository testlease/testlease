import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestLeaseClient } from '@testlease/client';
import type { CallOptions, EventsResponse, TestLeaseError } from '@testlease/protocol';
import { ManualClock } from '../../../core/src/clock.js';
import {
  buyersConfig,
  expectError,
  SECRETS,
  startTestServer,
  TOKENS,
  type TestServer,
} from '../helpers.js';

// Test-only declaration of the forthcoming client method; never supplies a fallback.
type PoolEventsClient = TestLeaseClient & {
  listPoolEvents(
    pool: string,
    query: { sinceMs?: number; limit?: number },
    opts?: CallOptions,
  ): Promise<EventsResponse>;
};

const LOCAL_SECRETS = {
  ...SECRETS,
  TOKEN_BUYERS_ONLY: 'buyers-only-token-0123456789abcdef',
  TOKEN_NO_POOL_READ: 'no-pool-read-token-0123456789abcdef',
};

function assertNoSecrets(payload: unknown): void {
  const text = JSON.stringify(payload);
  for (const secret of Object.values(LOCAL_SECRETS)) {
    expect(text).not.toContain(secret);
  }
}

describe('GET /v1/pools/:pool/events', () => {
  let ts: TestServer;

  beforeEach(async () => {
    const input = buyersConfig();
    ts = await startTestServer({
      configInput: {
        ...input,
        pools: {
          ...(input.pools as Record<string, unknown>),
          admins: { resources: [{ id: 'admin-01' }] },
        },
        auth: {
          tokens: [
            ...TOKENS.tokens,
            {
              name: 'buyers-only',
              token: 'env:TOKEN_BUYERS_ONLY',
              scopes: ['pool:read', 'lease:read'],
              pools: ['buyers'],
            },
            {
              name: 'no-pool-read',
              token: 'env:TOKEN_NO_POOL_READ',
              scopes: ['lease:read'],
            },
          ],
        },
      },
      secrets: LOCAL_SECRETS,
    });
  });
  afterEach(() => ts.close());

  function client(token = SECRETS.TOKEN_CI): PoolEventsClient {
    return ts.client({ token, retries: 0 }) as PoolEventsClient;
  }

  async function listEvents(
    pool: string,
    query: { sinceMs?: number; limit?: number } = {},
    token = SECRETS.TOKEN_CI,
  ): Promise<EventsResponse> {
    const body = await client(token).listPoolEvents(pool, query);
    assertNoSecrets(body);
    return body;
  }

  async function get(path: string, token: string | undefined = SECRETS.TOKEN_CI) {
    const response = await fetch(`${ts.url}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    const text = await response.text();
    assertNoSecrets(text);
    const body: unknown = JSON.parse(text);
    assertNoSecrets(body);
    return { status: response.status, body };
  }

  // Query tests seed history with controlled timestamps. No server clock replacement,
  // mocks, sleeps, or timer-driven mutations are needed to test HTTP transport.
  function record(clock: ManualClock, owner: string, pool = 'buyers'): void {
    ts.engine.store.insertEvent({
      at: clock.now(),
      type: 'ACQUIRE_TIMEOUT',
      pool,
      owner,
      details: { waitedMs: 0, immediate: true },
    });
  }

  describe('#11 pool filtering over HTTP', () => {
    it('client.listPoolEvents returns only the requested pool, including ACQUIRE_TIMEOUT', async () => {
      const api = client();
      const buyers = [];
      for (let i = 0; i < 3; i++) {
        buyers.push(await api.acquire({ pool: 'buyers', owner: `holder-${i}` }));
      }
      await api.acquire({ pool: 'admins', owner: 'admin' });
      const error = await expectError<TestLeaseError>(
        api.acquire({ pool: 'buyers', owner: 'immediate' }),
      );
      expect(error).toMatchObject({ code: 'POOL_EXHAUSTED', status: 409 });
      const { events } = await listEvents('buyers');
      expect(
        events
          .filter((event) => event.type === 'LEASE_ACQUIRED')
          .map((event) => event.leaseId)
          .sort(),
      ).toEqual(buyers.map(({ lease }) => lease.leaseId).sort());
      expect(events.every((event) => event.pool === 'buyers')).toBe(true);
      const timeouts = events.filter((event) => event.type === 'ACQUIRE_TIMEOUT');
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]).toMatchObject({
        pool: 'buyers',
        owner: 'immediate',
        details: { immediate: true, waitedMs: 0 },
      });
      expect(timeouts[0]!.resourceId).toBeUndefined();
      expect(timeouts[0]!.leaseId).toBeUndefined();
    });

    it('event shape matches LeaseEvent and listResourceEvents over HTTP', async () => {
      const api = client();
      const { lease } = await api.acquire({ pool: 'buyers', owner: 'shape' });
      const resourceHistory = await api.listResourceEvents(lease.resourceId);
      assertNoSecrets(resourceHistory);
      const raw = await get('/v1/pools/buyers/events');
      expect(raw.status).toBe(200);
      const { events } = raw.body as EventsResponse;
      expect(events.filter((event) => event.resourceId === lease.resourceId)).toEqual(
        [...resourceHistory.events].sort((a, b) => b.at - a.at || b.seq - a.seq),
      );
      expect(events.find((event) => event.type === 'LEASE_ACQUIRED')).toMatchObject({
        seq: expect.any(Number) as unknown,
        at: lease.createdAt,
        type: 'LEASE_ACQUIRED',
        pool: 'buyers',
        resourceId: lease.resourceId,
        leaseId: lease.leaseId,
        owner: 'shape',
        details: expect.any(Object) as unknown,
      });
      expect(await listEvents('buyers')).toEqual(raw.body);
    });

    it('returns 404 POOL_NOT_FOUND for an unknown pool', async () => {
      const raw = await get('/v1/pools/missing/events');
      expect(raw).toMatchObject({ status: 404, body: { error: { code: 'POOL_NOT_FOUND' } } });
      const error = await expectError<TestLeaseError>(() => listEvents('missing'));
      expect(error).toMatchObject({ code: 'POOL_NOT_FOUND', status: 404 });
    });

    it('never exposes secret values in the HTTP event response after secret resolution', async () => {
      const api = client();
      const { lease } = await api.acquire({ pool: 'buyers', owner: 'secrets' });
      const resolved = await api.resolveSecrets(lease.leaseId, { owner: 'secrets' });
      expect(resolved.secrets).toEqual({ password: SECRETS.BUYER_01_PASSWORD });
      const history = await api.listLeaseEvents(lease.leaseId);
      assertNoSecrets(history);
      expect(history.events.some((event) => event.type === 'LEASE_SECRETS_RESOLVED')).toBe(true);
      const raw = await get('/v1/pools/buyers/events');
      expect(raw.status).toBe(200);
      const { events } = raw.body as EventsResponse;
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'LEASE_ACQUIRED', leaseId: lease.leaseId }),
        ]),
      );
      // Secret-resolution events are allowed, but not required, in this API.
      // get() checks the entire raw response regardless of which event types it includes.
      expect(await listEvents('buyers')).toEqual(raw.body);
    });
  });

  describe('#12 query parameters', () => {
    it('since is inclusive and results are ordered by at DESC, then seq DESC', async () => {
      const clock = new ManualClock(ts.engine.clock.now());
      clock.advance(1);
      record(clock, 'before');
      clock.advance(1);
      const sinceMs = clock.now();
      record(clock, 'boundary');
      clock.advance(1);
      record(clock, 'newest');
      record(clock, 'other-pool', 'admins');
      clock.advance(-1);
      record(clock, 'boundary-later-seq');
      const expected = ['newest', 'boundary-later-seq', 'boundary'];
      const raw = await get(`/v1/pools/buyers/events?since=${sinceMs}`);
      expect(raw.status).toBe(200);
      expect((raw.body as EventsResponse).events.map((event) => event.owner)).toEqual(expected);
      const fromClient = await listEvents('buyers', { sinceMs });
      expect(fromClient).toEqual(raw.body);
      expect(
        (await listEvents('buyers', { sinceMs, limit: 2 })).events.map((event) => event.owner),
      ).toEqual(expected.slice(0, 2));
    });

    it('limit defaults to 1000, honours explicit limits and caps at 5000', async () => {
      const clock = new ManualClock(ts.engine.clock.now());
      clock.advance(1);
      const sinceMs = clock.now();
      ts.engine.store.transaction(() => {
        for (let i = 0; i < 5001; i++) {
          record(clock, `event-${i}`);
          clock.advance(1);
        }
      });
      for (const [limit, count] of [
        [undefined, 1000],
        [2, 2],
        [5000, 5000],
        [5001, 5000],
      ] as const) {
        const suffix = limit === undefined ? '' : `&limit=${limit}`;
        const raw = await get(`/v1/pools/buyers/events?since=${sinceMs}${suffix}`);
        expect(raw.status).toBe(200);
        expect((raw.body as EventsResponse).events.map((event) => event.owner)).toEqual(
          Array.from({ length: count }, (_, i) => `event-${5000 - i}`),
        );
        expect(
          await listEvents('buyers', { sinceMs, ...(limit === undefined ? {} : { limit }) }),
        ).toEqual(raw.body);
      }
    });

    it.each([
      'since=abc',
      'limit=abc',
      'limit=0',
      'since=-1',
      'limit=-1',
      'since=1.5',
      'limit=1.5',
    ])('%s returns 400 INVALID_REQUEST', async (query) => {
      expect(await get(`/v1/pools/buyers/events?${query}`)).toMatchObject({
        status: 400,
        body: { error: { code: 'INVALID_REQUEST' } },
      });
    });
  });

  describe('#13 pool-scoped tokens', () => {
    it('a token restricted to buyers gets 403 FORBIDDEN for another pool', async () => {
      const token = LOCAL_SECRETS.TOKEN_BUYERS_ONLY;
      expect(await get('/v1/pools/admins/events', token)).toMatchObject({
        status: 403,
        body: { error: { code: 'FORBIDDEN' } },
      });
      const error = await expectError<TestLeaseError>(() => listEvents('admins', {}, token));
      expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    });

    it('the same token reads events of buyers', async () => {
      const { lease } = await client().acquire({ pool: 'buyers', owner: 'allowed' });
      await client().acquire({ pool: 'admins', owner: 'other' });
      const token = LOCAL_SECRETS.TOKEN_BUYERS_ONLY;
      const raw = await get('/v1/pools/buyers/events', token);
      expect(raw.status).toBe(200);
      const body = await listEvents('buyers', {}, token);
      expect(body).toEqual(raw.body);
      expect(body.events.every((event) => event.pool === 'buyers')).toBe(true);
      expect(body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'LEASE_ACQUIRED', leaseId: lease.leaseId }),
        ]),
      );
    });
  });

  describe('#14 scopes and auth', () => {
    it('no token in token mode returns 401 UNAUTHORIZED', async () => {
      expect(await get('/v1/pools/buyers/events', '')).toMatchObject({
        status: 401,
        body: { error: { code: 'UNAUTHORIZED' } },
      });
      const anonymous = ts.client({ retries: 0 }) as PoolEventsClient;
      const error = await expectError<TestLeaseError>(() => anonymous.listPoolEvents('buyers', {}));
      assertNoSecrets(error);
      expect(error).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
    });

    it('a local token without pool:read returns 403 FORBIDDEN', async () => {
      const token = LOCAL_SECRETS.TOKEN_NO_POOL_READ;
      expect(await get('/v1/pools/buyers/events', token)).toMatchObject({
        status: 403,
        body: { error: { code: 'FORBIDDEN' } },
      });
      const error = await expectError<TestLeaseError>(() => listEvents('buyers', {}, token));
      expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    });

    it('the reader token (pool:read, lease:read) is allowed', async () => {
      const { lease } = await client().acquire({ pool: 'buyers', owner: 'reader-test' });
      const raw = await get('/v1/pools/buyers/events', SECRETS.TOKEN_READER);
      expect(raw.status).toBe(200);
      const body = await listEvents('buyers', {}, SECRETS.TOKEN_READER);
      expect(body).toEqual(raw.body);
      expect(body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'LEASE_ACQUIRED', leaseId: lease.leaseId }),
        ]),
      );
    });
  });

  describe('openapi', () => {
    it('/openapi.json documents GET /v1/pools/{pool}/events and its query parameters', async () => {
      const raw = await get('/openapi.json');
      expect(raw.status).toBe(200);
      const document = raw.body as { paths: Record<string, { get?: unknown }> };
      expect(document.paths['/v1/pools/{pool}/events']?.get).toMatchObject({
        parameters: expect.arrayContaining([
          expect.objectContaining({ name: 'pool', in: 'path', required: true }),
          expect.objectContaining({
            name: 'since',
            in: 'query',
            schema: expect.objectContaining({ type: 'integer' }) as unknown,
          }),
          expect.objectContaining({
            name: 'limit',
            in: 'query',
            schema: expect.objectContaining({
              type: 'integer',
              default: 1000,
              maximum: 5000,
            }) as unknown,
          }),
        ]) as unknown,
        responses: { '200': expect.any(Object) as unknown },
      });
    });
  });
});
