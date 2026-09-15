import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { HttpBindings } from '@hono/node-server';
import {
  ErrorCodes,
  TestLeaseError,
  type AcquireRequest,
  type EventsResponse,
  type PoolsResponse,
  type QuarantineRequest,
  type QuarantineResourceRequest,
  type ReleaseRequest,
  type RenewRequest,
  type ResolveSecretsRequest,
  type Scope,
  type WhoAmIResponse,
} from '@testlease/protocol';
import { idSchema, validate, type Logger, type TestLeaseEngine } from '@testlease/core';
import { requireScope, type AuthContext, type Authenticator } from './auth.js';
import { toErrorResponse } from './http-errors.js';

export interface AppVariables {
  auth: AuthContext;
  requestId: string;
  log: Logger;
}

export type AppEnv = { Variables: AppVariables; Bindings: HttpBindings };
export type TestLeaseApp = Hono<AppEnv>;

export interface CreateAppOptions {
  engine: TestLeaseEngine;
  authenticator: Authenticator;
  logger: Logger;
  bodyLimitBytes?: number;
  /** Mount additional routes (used for the MCP endpoint). Called after auth middleware is installed. */
  extend?: (app: TestLeaseApp) => void;
}

function withChild(logger: Logger, bindings: Record<string, unknown>): Logger {
  const maybe = logger as Logger & { child?: (b: Record<string, unknown>) => Logger };
  return typeof maybe.child === 'function' ? maybe.child(bindings) : logger;
}

/**
 * Builds the versioned REST API. Every handler delegates to the in-process API bound to the
 * authenticated principal, so REST has no leasing logic of its own.
 */
export function createApp(options: CreateAppOptions): TestLeaseApp {
  const { engine, authenticator, logger } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id')?.slice(0, 64) ?? randomUUID();
    const started = Date.now();
    c.set('requestId', requestId);
    c.set('log', withChild(logger, { requestId }));
    c.header('x-request-id', requestId);
    await next();
    const durationMs = Date.now() - started;
    const level = c.res.status >= 500 ? 'error' : c.res.status >= 400 ? 'warn' : 'info';
    logger[level](
      {
        event: 'http.request',
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs,
        principal: c.get('auth')?.principal,
      },
      'request',
    );
  });

  app.onError((err, c) => {
    const { status, body } = toErrorResponse(
      err,
      c.get('log') ?? logger,
      c.get('requestId') ?? '-',
    );
    return c.json(body, status as 400);
  });

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: ErrorCodes.NOT_FOUND,
          message: `No route for ${c.req.method} ${c.req.path}.`,
        },
      },
      404,
    ),
  );

  app.get('/healthz', async (c) => c.json(await engine.api.health()));

  // ---- authentication for everything under /v1 --------------------------------------------
  app.use('/v1/*', async (c, next) => {
    const auth = authenticator.authenticate(c.req.header('authorization'));
    if (!auth) {
      throw new TestLeaseError(
        ErrorCodes.UNAUTHORIZED,
        'Missing or invalid API token. Send "Authorization: Bearer <token>".',
      );
    }
    c.set('auth', auth);
    await next();
  });

  app.use(
    '/v1/*',
    bodyLimit({
      maxSize: options.bodyLimitBytes ?? 65_536,
      onError: (c) =>
        c.json(
          {
            error: {
              code: ErrorCodes.INVALID_REQUEST,
              message: `Request body exceeds ${options.bodyLimitBytes ?? 65_536} bytes.`,
            },
          },
          413,
        ),
    }),
  );

  const api = (c: Context<AppEnv>) => engine.api.as(c.get('auth').principal);
  const scoped = (c: Context<AppEnv>, scope: Scope) => {
    requireScope(c.get('auth'), scope);
    return api(c);
  };
  const param = (c: Context<AppEnv>, name: string) => validate(idSchema, c.req.param(name), name);
  const json = async <T>(c: Context<AppEnv>): Promise<T> => {
    const text = await c.req.text();
    if (text.trim() === '') return {} as T;
    return JSON.parse(text) as T;
  };
  const forceGuard = (c: Context<AppEnv>, body: { force?: boolean }) => {
    if (body.force) requireScope(c.get('auth'), 'lease:admin');
  };

  app.get('/v1/whoami', (c) => {
    const auth = c.get('auth');
    const body: WhoAmIResponse = {
      auth: auth.mode,
      principal: auth.principal,
      scopes: [...auth.scopes],
    };
    return c.json(body);
  });

  // ---- pools & resources ---------------------------------------------------------------------
  app.get('/v1/pools', async (c) => {
    const body: PoolsResponse = { pools: await scoped(c, 'pool:read').listPools() };
    return c.json(body);
  });
  app.get('/v1/pools/:pool', async (c) =>
    c.json(await scoped(c, 'pool:read').getPool(param(c, 'pool'))),
  );
  app.get('/v1/resources/:resourceId', async (c) =>
    c.json(await scoped(c, 'pool:read').getResource(param(c, 'resourceId'))),
  );
  app.get('/v1/resources/:resourceId/events', async (c) => {
    const body: EventsResponse = await scoped(c, 'pool:read').listResourceEvents(
      param(c, 'resourceId'),
    );
    return c.json(body);
  });
  app.post('/v1/resources/:resourceId/quarantine', async (c) => {
    const body = await json<QuarantineResourceRequest>(c);
    return c.json(
      await scoped(c, 'resource:admin').quarantineResource(param(c, 'resourceId'), body),
    );
  });
  app.post('/v1/resources/:resourceId/restore', async (c) =>
    c.json(await scoped(c, 'resource:admin').restoreResource(param(c, 'resourceId'))),
  );

  // ---- leases --------------------------------------------------------------------------------
  app.post('/v1/leases/acquire', async (c) => {
    const body = await json<AcquireRequest>(c);
    const disconnect = watchDisconnect(c);
    try {
      const result = await scoped(c, 'lease:write').acquire(body, { signal: disconnect.signal });
      return c.json(result, 200);
    } finally {
      disconnect.dispose();
    }
  });
  app.get('/v1/leases/:leaseId', async (c) =>
    c.json(await scoped(c, 'lease:read').getLease(param(c, 'leaseId'))),
  );
  app.get('/v1/leases/:leaseId/events', async (c) => {
    const body: EventsResponse = await scoped(c, 'lease:read').listLeaseEvents(param(c, 'leaseId'));
    return c.json(body);
  });
  app.post('/v1/leases/:leaseId/renew', async (c) => {
    const body = await json<RenewRequest>(c);
    return c.json(await scoped(c, 'lease:write').renew(param(c, 'leaseId'), body));
  });
  const release = async (c: Context<AppEnv>) => {
    const body = await json<ReleaseRequest>(c);
    forceGuard(c, body);
    return c.json(await scoped(c, 'lease:write').release(param(c, 'leaseId'), body));
  };
  app.post('/v1/leases/:leaseId/release', release);
  app.delete('/v1/leases/:leaseId', release);
  app.post('/v1/leases/:leaseId/quarantine', async (c) => {
    const body = await json<QuarantineRequest>(c);
    forceGuard(c, body);
    return c.json(await scoped(c, 'lease:write').quarantine(param(c, 'leaseId'), body));
  });
  app.post('/v1/leases/:leaseId/secrets', async (c) => {
    const body = await json<ResolveSecretsRequest>(c);
    // Values are returned to the caller and nowhere else: not logged, not stored.
    return c.json(await scoped(c, 'secrets:resolve').resolveSecrets(param(c, 'leaseId'), body));
  });

  app.get('/v1/events', (c) => {
    requireScope(c.get('auth'), 'lease:read');
    const limitRaw = c.req.query('limit');
    const limit = Math.min(Math.max(Number(limitRaw ?? 100) || 100, 1), 1000);
    const body: EventsResponse = { events: engine.service.listRecentEvents(limit) };
    return c.json(body);
  });

  options.extend?.(app);
  return app;
}

/**
 * Signals when the HTTP client goes away while the request is still pending. Before a response
 * has started, a `close` on the incoming message or its socket can only mean the peer closed the
 * connection, so a waiting acquisition is removed from the queue instead of being assigned a
 * resource nobody will use. Listeners are removed once the request settles so keep-alive sockets
 * do not accumulate them.
 */
function watchDisconnect(c: Context<AppEnv>): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const raw = c.req.raw.signal;
  raw.addEventListener('abort', abort, { once: true });
  const incoming = c.env?.incoming;
  const socket = incoming?.socket;
  incoming?.once('close', abort);
  socket?.once('close', abort);
  return {
    signal: controller.signal,
    dispose: () => {
      raw.removeEventListener('abort', abort);
      incoming?.off('close', abort);
      socket?.off('close', abort);
    },
  };
}
