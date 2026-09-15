import { createHash, timingSafeEqual } from 'node:crypto';
import { ErrorCodes, Scopes, TestLeaseError, type AuthMode, type Scope } from '@testlease/protocol';
import type { SecretResolverRegistry, TestLeaseConfig } from '@testlease/core';

export const ALL_SCOPES: readonly Scope[] = Scopes;

export interface ResolvedToken {
  name: string;
  /** sha256 of the token value; the plaintext is dropped after hashing. */
  hash: Buffer;
  scopes: Scope[];
}

export interface AuthContext {
  mode: AuthMode;
  /** Token name, or `local` in insecure-local mode. Becomes `lease.principal`. */
  principal: string;
  scopes: ReadonlySet<Scope>;
}

export interface Authenticator {
  mode: AuthMode;
  authenticate(authorizationHeader: string | undefined): AuthContext | null;
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Resolves `env:` token references and hashes every token. Never logs token values. */
export async function resolveTokens(
  config: TestLeaseConfig,
  secrets: SecretResolverRegistry,
): Promise<ResolvedToken[]> {
  const out: ResolvedToken[] = [];
  for (const t of config.auth.tokens) {
    const value = /^[a-z][a-z0-9-]*:/.test(t.token) ? await secrets.resolve(t.token) : t.token;
    if (value.length < 16) {
      throw new Error(`auth.tokens[${t.name}]: resolved token must be at least 16 characters`);
    }
    out.push({ name: t.name, hash: hashToken(value), scopes: [...t.scopes] });
  }
  return out;
}

export function createAuthenticator(tokens: ResolvedToken[]): Authenticator {
  if (tokens.length === 0) {
    const local: AuthContext = {
      mode: 'insecure-local',
      principal: 'local',
      scopes: new Set(ALL_SCOPES),
    };
    return { mode: 'insecure-local', authenticate: () => local };
  }
  return {
    mode: 'token',
    authenticate(header) {
      if (!header) return null;
      const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
      if (!m) return null;
      const presented = hashToken(m[1]!);
      // Compare against every token so the response time does not reveal which one matched.
      let matched: ResolvedToken | null = null;
      for (const token of tokens) {
        if (timingSafeEqual(presented, token.hash)) matched = token;
      }
      if (!matched) return null;
      return { mode: 'token', principal: matched.name, scopes: new Set(matched.scopes) };
    },
  };
}

export function requireScope(ctx: AuthContext, scope: Scope): void {
  if (ctx.scopes.has(scope)) return;
  throw new TestLeaseError(
    ErrorCodes.FORBIDDEN,
    `This operation requires the "${scope}" scope; token "${ctx.principal}" has: ${[...ctx.scopes].join(', ') || '(none)'}.`,
    { requiredScope: scope, principal: ctx.principal },
  );
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    h === 'localhost' ||
    h === '::1' ||
    h === '[::1]' ||
    h === '::ffff:127.0.0.1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}
