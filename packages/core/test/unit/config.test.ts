import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyEnvOverrides,
  checkSecretRefs,
  ConfigError,
  formatSecretProblems,
  loadConfigFile,
  validateConfig,
} from '../../src/config/load.js';
import { EnvSecretResolver, SecretResolverRegistry } from '../../src/secrets/resolver.js';
import { baseConfigInput, tempDir } from '../helpers.js';

describe('validateConfig', () => {
  it('applies defaults', () => {
    const { config, warnings } = validateConfig(baseConfigInput());
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.pools.buyers!.resources[0]!.tags).toEqual({
      region: 'nl',
      paymentMethod: 'ideal',
    });
    expect(config.pools.buyers!.resources[0]!.metadata).toEqual({ email: 'buyer01@example.test' });
    expect(config.server.port).toBe(4747);
    expect(config.pools.buyers!.defaultTtl).toBe(600_000);
    expect(config.pools.buyers!.maxTtl).toBe(3_600_000);
    expect(config.pools.admins!.maxTtl).toBe(3_600_000);
    expect(config.pools.buyers!.resources[0]!.enabled).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('fails when two resources share an id, even across pools', () => {
    const input = baseConfigInput() as { pools: Record<string, { resources: { id: string }[] }> };
    input.pools.admins!.resources.push({ id: 'buyer-01' });
    const err = (() => {
      try {
        validateConfig(input);
      } catch (e) {
        return e as ConfigError;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err!.problems.join('\n')).toMatch(/resource id "buyer-01" is defined twice/);
    expect(err!.problems.join('\n')).toMatch(/pools "buyers" and "admins"/);
  });

  it('fails on invalid TTLs', () => {
    expect(() => validateConfig({ pools: { p: { defaultTtl: '0s' } } })).toThrow(
      /TTL must be between 1s and 7d/,
    );
    expect(() => validateConfig({ pools: { p: { defaultTtl: 'soon' } } })).toThrow(
      /Invalid duration/,
    );
    expect(() => validateConfig({ pools: { p: { defaultTtl: '2h', maxTtl: '1h' } } })).toThrow(
      /exceeds maxTtl/,
    );
  });

  it('coerces tag values to strings', () => {
    const { config } = validateConfig({
      pools: { p: { resources: [{ id: 'a', tags: { slot: 1, premium: true } }] } },
    });
    expect(config.pools.p!.resources[0]!.tags).toEqual({ slot: '1', premium: 'true' });
  });

  it('warns (not fails) for an empty pool', () => {
    const { warnings } = validateConfig({ pools: { empty: {} } });
    expect(warnings[0]).toMatch(/pools.empty has no resources/);
  });

  it('rejects unknown keys so typos are caught', () => {
    expect(() => validateConfig({ pools: { p: { defaultTTL: '1m' } } })).toThrow(
      /Unrecognized key|unrecognized/i,
    );
  });

  it('rejects secret references without a provider and invalid identifiers', () => {
    expect(() =>
      validateConfig({
        pools: { p: { resources: [{ id: 'a', secrets: { password: 'plaintext' } }] } },
      }),
    ).toThrow(/secret references look like env:VAR_NAME/);
    expect(() => validateConfig({ pools: { p: { resources: [{ id: 'has space' }] } } })).toThrow(
      /identifiers/,
    );
  });

  it('requires literal tokens to be long enough and unique names', () => {
    expect(() => validateConfig({ auth: { tokens: [{ name: 'ci', token: 'short' }] } })).toThrow(
      /at least 16 characters/,
    );
    expect(() =>
      validateConfig({
        auth: {
          tokens: [
            { name: 'ci', token: 'env:A' },
            { name: 'ci', token: 'env:B' },
          ],
        },
      }),
    ).toThrow(/used more than once/);
  });
});

describe('loadConfigFile', () => {
  it('reports a missing file and invalid YAML clearly', () => {
    expect(() => loadConfigFile('/nonexistent/testlease.yml')).toThrow(/file not found/);
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, 'bad.yml');
      writeFileSync(path, 'pools:\n  a: [\n');
      expect(() => loadConfigFile(path)).toThrow(/not valid YAML/);
    } finally {
      cleanup();
    }
  });

  it('loads YAML', () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, 'testlease.yml');
      writeFileSync(
        path,
        `pools:\n  premium-buyers:\n    defaultTtl: 10m\n    resources:\n      - id: buyer-01\n        metadata:\n          region: nl\n        secrets:\n          password: env:BUYER_01_PASSWORD\n`,
      );
      const { config } = loadConfigFile(path);
      expect(config.pools['premium-buyers']!.resources[0]!.secrets.password).toBe(
        'env:BUYER_01_PASSWORD',
      );
    } finally {
      cleanup();
    }
  });
});

describe('applyEnvOverrides', () => {
  it('overrides host/port/db and adds a default token', () => {
    const { config } = validateConfig({});
    const out = applyEnvOverrides(config, {
      TESTLEASE_HOST: '0.0.0.0',
      TESTLEASE_PORT: '5000',
      TESTLEASE_DB: '/data/tl.db',
      TESTLEASE_TOKEN: 'a-very-long-token-value-123',
    });
    expect(out.server.host).toBe('0.0.0.0');
    expect(out.server.port).toBe(5000);
    expect(out.server.db).toBe('/data/tl.db');
    expect(out.auth.tokens).toHaveLength(1);
    expect(out.auth.tokens[0]!.token).toBe('env:TESTLEASE_TOKEN');
    expect(out.auth.tokens[0]!.scopes).toContain('secrets:resolve');
  });
  it('rejects bad values', () => {
    const { config } = validateConfig({});
    expect(() => applyEnvOverrides(config, { TESTLEASE_PORT: 'abc' })).toThrow(/not a valid port/);
    expect(() => applyEnvOverrides(config, { TESTLEASE_TOKEN: 'short' })).toThrow(/at least 16/);
  });
});

describe('checkSecretRefs', () => {
  it('lists every missing environment variable with a fix hint, never the values', async () => {
    const { config } = validateConfig(baseConfigInput());
    const registry = new SecretResolverRegistry([
      new EnvSecretResolver({ BUYER_01_PASSWORD: 'present' }),
    ]);
    const problems = await checkSecretRefs(config, registry);
    expect(problems.map((p) => p.ref).sort()).toEqual([
      'env:ADMIN_PASSWORD',
      'env:BUYER_02_PASSWORD',
      'env:BUYER_03_PASSWORD',
    ]);
    const text = formatSecretProblems(problems);
    expect(text).toMatch(/3 secret reference\(s\) cannot be resolved/);
    expect(text).toMatch(/export BUYER_02_PASSWORD=/);
    expect(text).not.toContain('present');
  });
  it('flags unknown providers', async () => {
    const { config } = validateConfig({
      pools: { p: { resources: [{ id: 'a', secrets: { k: 'vault:secret/a' } }] } },
    });
    const problems = await checkSecretRefs(config, new SecretResolverRegistry());
    expect(problems[0]!.problem).toMatch(/unknown secret provider "vault"/);
  });
});
