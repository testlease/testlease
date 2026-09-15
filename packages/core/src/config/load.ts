import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { configSchema, type TestLeaseConfig } from './schema.js';
import { formatDuration } from '../duration.js';
import type { SecretResolverRegistry } from '../secrets/resolver.js';
import { LIMITS } from '../validation.js';

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(message: string, problems: string[] = []) {
    super(problems.length ? `${message}\n${problems.map((p) => `  - ${p}`).join('\n')}` : message);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export interface LoadedConfig {
  config: TestLeaseConfig;
  warnings: string[];
  /** Where the configuration came from, for diagnostics. */
  source: string;
}

/** Validates raw (already parsed) configuration data and applies cross-field rules. */
export function validateConfig(raw: unknown, source = '<inline>'): LoadedConfig {
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => {
      const path = i.path.length ? i.path.map(String).join('.') : '(root)';
      return `${path}: ${i.message}`;
    });
    throw new ConfigError(`Invalid configuration in ${source}`, problems);
  }

  const problems: string[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, string>();
  const pools: TestLeaseConfig['pools'] = {};

  for (const [poolName, pool] of Object.entries(parsed.data.pools)) {
    const maxTtl = pool.maxTtl ?? Math.max(pool.defaultTtl, 3_600_000);
    if (pool.defaultTtl > maxTtl) {
      problems.push(
        `pools.${poolName}: defaultTtl (${formatDuration(pool.defaultTtl)}) exceeds maxTtl (${formatDuration(maxTtl)})`,
      );
    }
    if (pool.resources.length === 0) {
      warnings.push(
        `pools.${poolName} has no resources; every acquisition will fail with NO_MATCHING_RESOURCE until resources are added`,
      );
    }
    for (const resource of pool.resources) {
      const prev = seen.get(resource.id);
      if (prev) {
        problems.push(
          `resource id "${resource.id}" is defined twice (pools "${prev}" and "${poolName}"); resource ids must be unique across all pools`,
        );
      } else {
        seen.set(resource.id, poolName);
      }
      if (Object.keys(resource.metadata).length > LIMITS.maxMetadataEntries) {
        problems.push(
          `pools.${poolName}.resources[${resource.id}]: at most ${LIMITS.maxMetadataEntries} metadata entries`,
        );
      }
    }
    pools[poolName] = { ...pool, maxTtl };
  }

  const tokenNames = new Set<string>();
  for (const token of parsed.data.auth.tokens) {
    if (tokenNames.has(token.name)) {
      problems.push(`auth.tokens: token name "${token.name}" is used more than once`);
    }
    tokenNames.add(token.name);
    if (!token.token.includes(':') && token.token.length < 16) {
      problems.push(
        `auth.tokens[${token.name}]: literal tokens must be at least 16 characters (prefer an env: reference)`,
      );
    }
  }

  if (problems.length) {
    throw new ConfigError(`Invalid configuration in ${source}`, problems);
  }

  const config: TestLeaseConfig = {
    server: parsed.data.server,
    auth: parsed.data.auth,
    mcp: parsed.data.mcp,
    pools,
  };
  return { config, warnings, source };
}

export function loadConfigFile(path: string): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `Cannot read configuration file ${path}: ${(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found' : (err as Error).message}`,
    );
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(
      `Configuration file ${path} is not valid YAML: ${(err as Error).message}`,
    );
  }
  return validateConfig(raw, path);
}

export interface EnvOverrides {
  TESTLEASE_HOST?: string;
  TESTLEASE_PORT?: string;
  TESTLEASE_DB?: string;
  TESTLEASE_LOG_LEVEL?: string;
  /** Shorthand: a single full-scope token named "default". */
  TESTLEASE_TOKEN?: string;
  TESTLEASE_ALLOW_INSECURE_REMOTE?: string;
}

/** Environment variables override file values (useful in Docker). */
export function applyEnvOverrides(
  config: TestLeaseConfig,
  env: NodeJS.ProcessEnv = process.env,
): TestLeaseConfig {
  const server = { ...config.server };
  const problems: string[] = [];
  if (env.TESTLEASE_HOST) server.host = env.TESTLEASE_HOST;
  if (env.TESTLEASE_PORT) {
    const port = Number(env.TESTLEASE_PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      problems.push(`TESTLEASE_PORT="${env.TESTLEASE_PORT}" is not a valid port`);
    } else {
      server.port = port;
    }
  }
  if (env.TESTLEASE_DB) server.db = env.TESTLEASE_DB;
  if (env.TESTLEASE_LOG_LEVEL) {
    const level = z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .safeParse(env.TESTLEASE_LOG_LEVEL);
    if (level.success) server.logLevel = level.data;
    else problems.push(`TESTLEASE_LOG_LEVEL="${env.TESTLEASE_LOG_LEVEL}" is not a valid log level`);
  }
  if (
    env.TESTLEASE_ALLOW_INSECURE_REMOTE === '1' ||
    env.TESTLEASE_ALLOW_INSECURE_REMOTE === 'true'
  ) {
    server.allowInsecureRemote = true;
  }
  const tokens = [...config.auth.tokens];
  if (env.TESTLEASE_TOKEN) {
    if (env.TESTLEASE_TOKEN.length < 16) {
      problems.push('TESTLEASE_TOKEN must be at least 16 characters');
    }
    tokens.push({
      name: 'default',
      token: 'env:TESTLEASE_TOKEN',
      scopes: [
        'lease:read',
        'lease:write',
        'lease:admin',
        'pool:read',
        'resource:admin',
        'secrets:resolve',
      ],
    });
  }
  if (problems.length) throw new ConfigError('Invalid environment configuration', problems);
  return { ...config, server, auth: { tokens } };
}

export interface SecretRefProblem {
  pool: string;
  resourceId: string;
  secretName: string;
  ref: string;
  problem: string;
}

/** Checks that every configured secret reference can be resolved. Never returns values. */
export async function checkSecretRefs(
  config: TestLeaseConfig,
  registry: SecretResolverRegistry,
): Promise<SecretRefProblem[]> {
  const problems: SecretRefProblem[] = [];
  for (const [pool, poolConfig] of Object.entries(config.pools)) {
    for (const resource of poolConfig.resources) {
      for (const [secretName, ref] of Object.entries(resource.secrets)) {
        const check = await registry.check(ref);
        if (!check.ok) {
          problems.push({
            pool,
            resourceId: resource.id,
            secretName,
            ref,
            problem: check.problem ?? 'unresolvable',
          });
        }
      }
    }
  }
  return problems;
}

export function formatSecretProblems(problems: SecretRefProblem[]): string {
  const lines = problems.map(
    (p) => `${p.pool}/${p.resourceId}.secrets.${p.secretName} -> ${p.ref}: ${p.problem}`,
  );
  const envVars = [
    ...new Set(problems.filter((p) => p.ref.startsWith('env:')).map((p) => p.ref.slice(4))),
  ];
  let out = `${problems.length} secret reference(s) cannot be resolved:\n${lines.map((l) => `  - ${l}`).join('\n')}`;
  if (envVars.length) {
    out += `\n\nSet the missing environment variables before starting the server, for example:\n  export ${envVars.join('=...\n  export ')}=...`;
  }
  return out;
}
