/**
 * OpenAPI 3.1 description of the v1 API. Hand-maintained; `test/integration/openapi.test.ts`
 * fails when a registered route is missing here or a documented path has no route.
 */
const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } },
});

const okJson = (schema: string, description = 'OK') => ({
  description,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
});

const leaseIdParam = { name: 'leaseId', in: 'path', required: true, schema: { type: 'string' } };
const resourceIdParam = {
  name: 'resourceId',
  in: 'path',
  required: true,
  schema: { type: 'string' },
};
const poolParam = { name: 'pool', in: 'path', required: true, schema: { type: 'string' } };
const jsonBody = (schema: string) => ({
  required: true,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
});

export const openapiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'TestLease API',
    version: '1',
    description:
      'Exclusive, expiring leases for shared test resources. Errors are `{ "error": { "code", "message", "details" } }`; switch on `code`.',
    license: { name: 'Apache-2.0' },
  },
  servers: [{ url: 'http://127.0.0.1:4747' }],
  security: [{ bearer: [] }],
  paths: {
    '/healthz': {
      get: {
        summary: 'Liveness and build info',
        security: [],
        responses: { '200': okJson('Health') },
      },
    },
    '/openapi.json': {
      get: {
        summary: 'This document',
        security: [],
        responses: { '200': { description: 'OpenAPI document' } },
      },
    },
    '/metrics': {
      get: {
        summary: 'Prometheus text metrics (pool gauges, acquisition counters)',
        responses: {
          '200': { description: 'text/plain; version=0.0.4' },
          '401': errorResponse('Missing token'),
        },
      },
    },
    '/v1/whoami': {
      get: { summary: 'Identity of the caller', responses: { '200': okJson('WhoAmI') } },
    },
    '/v1/pools': { get: { summary: 'List pools', responses: { '200': okJson('Pools') } } },
    '/v1/pools/{pool}': {
      get: {
        summary: 'Pool detail with resources and waiters',
        parameters: [poolParam],
        responses: { '200': okJson('PoolDetail'), '404': errorResponse('POOL_NOT_FOUND') },
      },
    },
    '/v1/resources/{resourceId}': {
      get: {
        summary: 'Resource (current configuration and state)',
        parameters: [resourceIdParam],
        responses: { '200': okJson('Resource'), '404': errorResponse('RESOURCE_NOT_FOUND') },
      },
    },
    '/v1/resources/{resourceId}/events': {
      get: {
        summary: 'Resource event history',
        parameters: [resourceIdParam],
        responses: { '200': okJson('Events') },
      },
    },
    '/v1/resources/{resourceId}/quarantine': {
      post: {
        summary: 'Quarantine a resource (resource:admin)',
        parameters: [resourceIdParam],
        requestBody: jsonBody('QuarantineResourceRequest'),
        responses: { '200': okJson('ResourceEnvelope'), '409': errorResponse('RESOURCE_LEASED') },
      },
    },
    '/v1/resources/{resourceId}/restore': {
      post: {
        summary: 'Restore a quarantined resource (resource:admin)',
        parameters: [resourceIdParam],
        responses: {
          '200': okJson('ResourceEnvelope'),
          '409': errorResponse('RESOURCE_NOT_QUARANTINED'),
        },
      },
    },
    '/v1/leases': {
      get: {
        summary: 'List leases, newest first',
        parameters: [
          {
            name: 'state',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['ACTIVE', 'RELEASED', 'EXPIRED', 'ALL'],
              default: 'ACTIVE',
            },
          },
          { name: 'pool', in: 'query', schema: { type: 'string' } },
          { name: 'owner', in: 'query', schema: { type: 'string' } },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
          },
        ],
        responses: { '200': okJson('Leases') },
      },
    },
    '/v1/leases/acquire': {
      post: {
        summary: 'Acquire a lease (long-polls up to waitTimeoutMs)',
        requestBody: jsonBody('AcquireRequest'),
        responses: {
          '200': okJson('AcquireResponse'),
          '400': errorResponse('INVALID_REQUEST'),
          '404': errorResponse('POOL_NOT_FOUND'),
          '409': errorResponse(
            'NO_MATCHING_RESOURCE | POOL_EXHAUSTED | ACQUIRE_TIMEOUT | IDEMPOTENCY_CONFLICT',
          ),
          '503': errorResponse('SERVER_SHUTTING_DOWN'),
        },
      },
    },
    '/v1/leases/{leaseId}': {
      get: {
        summary: 'Get a lease',
        parameters: [leaseIdParam],
        responses: { '200': okJson('Lease'), '404': errorResponse('LEASE_NOT_FOUND') },
      },
      delete: {
        summary: 'Release (alias of POST .../release)',
        parameters: [leaseIdParam],
        requestBody: jsonBody('ReleaseRequest'),
        responses: { '200': okJson('ReleaseResponse') },
      },
    },
    '/v1/leases/{leaseId}/events': {
      get: {
        summary: 'Lease event history',
        parameters: [leaseIdParam],
        responses: { '200': okJson('Events') },
      },
    },
    '/v1/leases/{leaseId}/renew': {
      post: {
        summary: 'Renew (heartbeat)',
        parameters: [leaseIdParam],
        requestBody: jsonBody('RenewRequest'),
        responses: {
          '200': okJson('RenewResponse'),
          '403': errorResponse('LEASE_OWNERSHIP_MISMATCH'),
          '409': errorResponse('LEASE_EXPIRED | LEASE_NOT_ACTIVE'),
        },
      },
    },
    '/v1/leases/{leaseId}/release': {
      post: {
        summary: 'Release (idempotent)',
        parameters: [leaseIdParam],
        requestBody: jsonBody('ReleaseRequest'),
        responses: {
          '200': okJson('ReleaseResponse'),
          '403': errorResponse('LEASE_OWNERSHIP_MISMATCH | FORBIDDEN'),
        },
      },
    },
    '/v1/leases/{leaseId}/quarantine': {
      post: {
        summary: 'End the lease and quarantine its resource',
        parameters: [leaseIdParam],
        requestBody: jsonBody('QuarantineRequest'),
        responses: { '200': okJson('QuarantineResponse') },
      },
    },
    '/v1/leases/{leaseId}/secrets': {
      post: {
        summary:
          'Resolve secret values for an active lease (secrets:resolve; owner + principal must match)',
        parameters: [leaseIdParam],
        requestBody: jsonBody('ResolveSecretsRequest'),
        responses: {
          '200': okJson('ResolveSecretsResponse'),
          '403': errorResponse('FORBIDDEN | LEASE_OWNERSHIP_MISMATCH'),
        },
      },
    },
    '/v1/events': {
      get: {
        summary: 'Most recent events server-wide',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
          },
        ],
        responses: { '200': okJson('Events') },
      },
    },
    '/v1/config/reload': {
      post: {
        summary: 'Re-read and apply the configuration file (resource:admin)',
        responses: { '200': okJson('ConfigReload'), '422': errorResponse('CONFIG_INVALID') },
      },
    },
  },
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    schemas: {
      ErrorBody: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              details: { type: 'object' },
            },
          },
        },
      },
      Metadata: {
        type: 'object',
        additionalProperties: {
          oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
        },
      },
      Tags: { type: 'object', additionalProperties: { type: 'string' } },
      Health: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'shutting_down'] },
          version: { type: 'string' },
          uptimeMs: { type: 'integer' },
          now: { type: 'integer' },
          wallClockDriftMs: { type: 'integer' },
          db: { type: 'object', properties: { schemaVersion: { type: 'integer' } } },
          auth: { type: 'object', properties: { mode: { type: 'string' } } },
          mcp: { type: 'object', properties: { http: { type: 'boolean' } } },
          config: {
            type: 'object',
            properties: { loadedAt: { type: 'integer' }, reloads: { type: 'integer' } },
          },
        },
      },
      WhoAmI: {
        type: 'object',
        properties: {
          auth: { type: 'string' },
          principal: { type: 'string' },
          scopes: { type: 'array', items: { type: 'string' } },
          pools: { type: 'array', items: { type: 'string' } },
        },
      },
      PoolCounts: {
        type: 'object',
        properties: {
          available: { type: 'integer' },
          leased: { type: 'integer' },
          quarantined: { type: 'integer' },
          disabled: { type: 'integer' },
          total: { type: 'integer' },
        },
      },
      PoolSummary: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          defaultTtlMs: { type: 'integer' },
          maxTtlMs: { type: 'integer' },
          counts: { $ref: '#/components/schemas/PoolCounts' },
          waiting: { type: 'integer' },
        },
      },
      Pools: {
        type: 'object',
        properties: {
          pools: { type: 'array', items: { $ref: '#/components/schemas/PoolSummary' } },
        },
      },
      Resource: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          pool: { type: 'string' },
          state: { type: 'string', enum: ['AVAILABLE', 'LEASED', 'QUARANTINED', 'DISABLED'] },
          enabledInConfig: { type: 'boolean' },
          tags: { $ref: '#/components/schemas/Tags' },
          metadata: { $ref: '#/components/schemas/Metadata' },
          secretKeys: { type: 'array', items: { type: 'string' } },
          quarantine: {
            type: 'object',
            properties: {
              reason: { type: 'string' },
              at: { type: 'integer' },
              by: { type: 'string' },
            },
          },
          activeLease: {
            type: 'object',
            properties: {
              leaseId: { type: 'string' },
              owner: { type: 'string' },
              createdAt: { type: 'integer' },
              expiresAt: { type: 'integer' },
              purpose: { type: 'string' },
            },
          },
          lastLeasedAt: { type: 'integer' },
          createdAt: { type: 'integer' },
          updatedAt: { type: 'integer' },
        },
      },
      ResourceEnvelope: {
        type: 'object',
        properties: { resource: { $ref: '#/components/schemas/Resource' } },
      },
      PoolDetail: {
        allOf: [
          { $ref: '#/components/schemas/PoolSummary' },
          {
            type: 'object',
            properties: {
              resources: { type: 'array', items: { $ref: '#/components/schemas/Resource' } },
              waiters: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    owner: { type: 'string' },
                    tags: { $ref: '#/components/schemas/Tags' },
                    waitingForMs: { type: 'integer' },
                    purpose: { type: 'string' },
                  },
                },
              },
            },
          },
        ],
      },
      LeaseResourceSnapshot: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          pool: { type: 'string' },
          tags: { $ref: '#/components/schemas/Tags' },
          metadata: { $ref: '#/components/schemas/Metadata' },
          secretKeys: { type: 'array', items: { type: 'string' } },
        },
      },
      Lease: {
        type: 'object',
        properties: {
          leaseId: { type: 'string' },
          resourceId: { type: 'string' },
          pool: { type: 'string' },
          owner: { type: 'string' },
          principal: { type: 'string' },
          resource: { $ref: '#/components/schemas/LeaseResourceSnapshot' },
          state: { type: 'string', enum: ['ACTIVE', 'RELEASED', 'EXPIRED'] },
          ttlMs: { type: 'integer' },
          createdAt: { type: 'integer' },
          expiresAt: { type: 'integer' },
          lastHeartbeatAt: { type: 'integer' },
          renewCount: { type: 'integer' },
          endedAt: { type: 'integer' },
          endReason: {
            type: 'string',
            enum: ['RELEASED', 'QUARANTINED', 'EXPIRED', 'FORCE_RELEASED'],
          },
          clientRequestId: { type: 'string' },
          purpose: { type: 'string' },
          context: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
      Leases: {
        type: 'object',
        properties: { leases: { type: 'array', items: { $ref: '#/components/schemas/Lease' } } },
      },
      AcquireRequest: {
        type: 'object',
        required: ['pool', 'owner'],
        properties: {
          pool: { type: 'string' },
          owner: { type: 'string', description: 'Stable logical owner, e.g. run/project/worker-2' },
          tags: { $ref: '#/components/schemas/Tags' },
          ttlMs: { type: 'integer', minimum: 1000 },
          waitTimeoutMs: { type: 'integer', minimum: 0, default: 0 },
          clientRequestId: { type: 'string' },
          purpose: { type: 'string' },
          context: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
      AcquireResponse: {
        type: 'object',
        properties: {
          lease: { $ref: '#/components/schemas/Lease' },
          reused: { type: 'boolean' },
          waitedMs: { type: 'integer' },
        },
      },
      RenewRequest: {
        type: 'object',
        required: ['owner'],
        properties: { owner: { type: 'string' }, ttlMs: { type: 'integer' } },
      },
      RenewResponse: {
        type: 'object',
        properties: { lease: { $ref: '#/components/schemas/Lease' } },
      },
      ReleaseRequest: {
        type: 'object',
        required: ['owner'],
        properties: { owner: { type: 'string' }, force: { type: 'boolean' } },
      },
      ReleaseResponse: {
        type: 'object',
        properties: {
          lease: { $ref: '#/components/schemas/Lease' },
          outcome: { type: 'string', enum: ['released', 'already_released', 'already_expired'] },
        },
      },
      QuarantineRequest: {
        type: 'object',
        required: ['owner', 'reason'],
        properties: {
          owner: { type: 'string' },
          reason: { type: 'string' },
          force: { type: 'boolean' },
        },
      },
      QuarantineResourceRequest: {
        type: 'object',
        required: ['reason'],
        properties: { reason: { type: 'string' }, force: { type: 'boolean' } },
      },
      QuarantineResponse: {
        type: 'object',
        properties: {
          lease: { $ref: '#/components/schemas/Lease' },
          resource: { $ref: '#/components/schemas/Resource' },
        },
      },
      ResolveSecretsRequest: {
        type: 'object',
        required: ['owner'],
        properties: { owner: { type: 'string' } },
      },
      ResolveSecretsResponse: {
        type: 'object',
        properties: {
          leaseId: { type: 'string' },
          resourceId: { type: 'string' },
          secrets: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
      Event: {
        type: 'object',
        properties: {
          seq: { type: 'integer' },
          at: { type: 'integer' },
          type: { type: 'string' },
          pool: { type: 'string' },
          resourceId: { type: 'string' },
          leaseId: { type: 'string' },
          owner: { type: 'string' },
          details: { type: 'object' },
        },
      },
      Events: {
        type: 'object',
        properties: { events: { type: 'array', items: { $ref: '#/components/schemas/Event' } } },
      },
      ConfigReload: {
        type: 'object',
        properties: {
          pools: { type: 'integer' },
          resources: { type: 'integer' },
          registered: { type: 'array', items: { type: 'string' } },
          updated: { type: 'array', items: { type: 'string' } },
          disabled: { type: 'array', items: { type: 'string' } },
          enabled: { type: 'array', items: { type: 'string' } },
          absentPools: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          loadedAt: { type: 'integer' },
          reloads: { type: 'integer' },
        },
      },
    },
  },
} as const;

/** `METHOD /path` pairs documented above, with `{param}` normalised to `:param` (Hono style). */
export function documentedRoutes(): string[] {
  const out: string[] = [];
  for (const [path, ops] of Object.entries(openapiDocument.paths)) {
    for (const method of Object.keys(ops)) {
      out.push(`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`);
    }
  }
  return out.sort();
}
