import { z } from 'zod';
import { Scopes } from '@testlease/protocol';
import { parseDuration } from '../duration.js';
import { LIMITS } from '../validation.js';

const durationSchema = z.union([z.number(), z.string()]).transform((v, ctx) => {
  try {
    return parseDuration(v);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: (err as Error).message });
    return z.NEVER;
  }
});

const ttlDurationSchema = durationSchema.refine(
  (ms) => ms >= LIMITS.minTtlMs && ms <= LIMITS.maxTtlMs,
  { message: `TTL must be between 1s and 7d` },
);

const identifier = z
  .string()
  .min(1)
  .max(LIMITS.maxIdLength)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    'identifiers may contain letters, digits, ".", "_", ":" and "-" and must start with a letter or digit',
  );

const metadataValueSchema = z.union([z.string().max(1000), z.number(), z.boolean()]);

export const secretRefSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*:.+$/, 'secret references look like env:VAR_NAME');

export const resourceConfigSchema = z.strictObject({
  id: identifier,
  enabled: z.boolean().default(true),
  metadata: z
    .record(z.string().min(1).max(LIMITS.maxTagKeyLength), metadataValueSchema)
    .default({}),
  secrets: z
    .record(
      z
        .string()
        .regex(
          /^[A-Za-z_][A-Za-z0-9_]*$/,
          'secret names must be valid identifiers (used as env vars)',
        ),
      secretRefSchema,
    )
    .default({}),
});

export const poolConfigSchema = z.strictObject({
  description: z.string().max(500).optional(),
  defaultTtl: ttlDurationSchema.default(10 * 60_000),
  maxTtl: ttlDurationSchema.optional(),
  resources: z.array(resourceConfigSchema).default([]),
});

export const tokenConfigSchema = z.strictObject({
  name: identifier,
  /** Literal token or a secret reference (`env:TESTLEASE_TOKEN_CI`). */
  token: z.string().min(1),
  scopes: z.array(z.enum(Scopes)).default(['lease:read', 'lease:write', 'pool:read']),
});

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export const serverConfigSchema = z.strictObject({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(4747),
  /** SQLite file path, or `:memory:` for an ephemeral database. */
  db: z.string().min(1).default('./testlease.db'),
  /** Upper bound for `waitTimeoutMs` per acquisition request. Clients may loop. */
  maxWait: durationSchema.default(10 * 60_000),
  logLevel: z.enum(LOG_LEVELS).default('info'),
  /** Explicit opt-in to bind a non-loopback address without tokens. Logs a warning. */
  allowInsecureRemote: z.boolean().default(false),
  requestBodyLimitBytes: z.number().int().min(1024).max(1_048_576).default(65_536),
});

export const mcpConfigSchema = z.strictObject({
  /** Serve MCP over Streamable HTTP at /mcp on the same server. */
  http: z.boolean().default(true),
  /** Register the `testlease_quarantine` tool. Off by default (conservative). */
  allowQuarantine: z.boolean().default(false),
});

export const configSchema = z.strictObject({
  server: serverConfigSchema.prefault({}),
  auth: z
    .strictObject({
      tokens: z.array(tokenConfigSchema).default([]),
    })
    .prefault({}),
  mcp: mcpConfigSchema.prefault({}),
  pools: z.record(identifier, poolConfigSchema).default({}),
});

export type ResourceConfig = z.output<typeof resourceConfigSchema>;
export type PoolConfig = z.output<typeof poolConfigSchema> & { maxTtl: number };
export type TokenConfig = z.output<typeof tokenConfigSchema>;
export type ServerConfig = z.output<typeof serverConfigSchema>;
export type McpConfig = z.output<typeof mcpConfigSchema>;

export interface TestLeaseConfig {
  server: ServerConfig;
  auth: { tokens: TokenConfig[] };
  mcp: McpConfig;
  pools: Record<string, PoolConfig>;
}

export type ConfigInput = z.input<typeof configSchema>;
