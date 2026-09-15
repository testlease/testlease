import { describe, expect, it } from 'vitest';
import {
  EnvSecretResolver,
  parseSecretRef,
  SecretResolverRegistry,
} from '../../src/secrets/resolver.js';

describe('secret references', () => {
  it('parses provider and key', () => {
    expect(parseSecretRef('env:BUYER_01_PASSWORD')).toEqual({
      provider: 'env',
      key: 'BUYER_01_PASSWORD',
      raw: 'env:BUYER_01_PASSWORD',
    });
    expect(() => parseSecretRef('nope')).toThrow(/Expected "<provider>:<key>"/);
  });

  it('resolves from the provided environment only', async () => {
    const registry = new SecretResolverRegistry([new EnvSecretResolver({ A: 'value-a' })]);
    await expect(registry.resolve('env:A')).resolves.toBe('value-a');
    const err = await registry.resolve('env:B').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/environment variable B is not set/);
    expect((err as Error).message).not.toContain('value-a');
  });

  it('checks presence without revealing values', async () => {
    const registry = new SecretResolverRegistry([
      new EnvSecretResolver({ A: 'value-a', EMPTY: '' }),
    ]);
    expect(await registry.check('env:A')).toEqual({ ok: true });
    expect((await registry.check('env:EMPTY')).problem).toMatch(/not set/);
    expect((await registry.check('env:bad-name')).problem).toMatch(
      /not a valid environment variable name/,
    );
    expect((await registry.check('aws:foo')).problem).toMatch(/unknown secret provider "aws"/);
  });
});
