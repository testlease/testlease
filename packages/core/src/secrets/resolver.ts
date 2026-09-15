import { ErrorCodes, TestLeaseError } from '@testlease/protocol';

/** A parsed secret reference such as `env:BUYER_01_PASSWORD`. */
export interface SecretRef {
  provider: string;
  key: string;
  raw: string;
}

const REF_RE = /^([a-z][a-z0-9-]*):(.+)$/;

export function parseSecretRef(raw: string): SecretRef {
  const m = REF_RE.exec(raw.trim());
  if (!m) {
    throw new Error(
      `Invalid secret reference "${raw}". Expected "<provider>:<key>", for example env:BUYER_01_PASSWORD.`,
    );
  }
  return { provider: m[1]!, key: m[2]!, raw: raw.trim() };
}

export interface SecretCheck {
  ok: boolean;
  /** Human-readable hint when not ok, e.g. "environment variable BUYER_01_PASSWORD is not set". */
  problem?: string;
}

/**
 * Resolves secret references for one provider. Implementations for Vault, AWS Secrets Manager,
 * etc. plug in here without touching the leasing domain.
 */
export interface SecretResolver {
  readonly provider: string;
  /** Cheap presence check used at startup and by `testlease doctor`. Must not return the value. */
  check(ref: SecretRef): Promise<SecretCheck> | SecretCheck;
  resolve(ref: SecretRef): Promise<string>;
}

export class EnvSecretResolver implements SecretResolver {
  readonly provider = 'env';
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  check(ref: SecretRef): SecretCheck {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.key)) {
      return { ok: false, problem: `"${ref.key}" is not a valid environment variable name` };
    }
    const value = this.env[ref.key];
    if (value === undefined || value === '') {
      return { ok: false, problem: `environment variable ${ref.key} is not set` };
    }
    return { ok: true };
  }

  async resolve(ref: SecretRef): Promise<string> {
    const value = this.env[ref.key];
    if (value === undefined || value === '') {
      throw new TestLeaseError(
        ErrorCodes.SECRET_RESOLUTION_FAILED,
        `Secret reference ${ref.raw} could not be resolved: environment variable ${ref.key} is not set on the server`,
        { ref: ref.raw },
      );
    }
    return value;
  }
}

export class SecretResolverRegistry {
  private readonly resolvers = new Map<string, SecretResolver>();

  constructor(resolvers: SecretResolver[] = [new EnvSecretResolver()]) {
    for (const r of resolvers) this.register(r);
  }

  register(resolver: SecretResolver): void {
    this.resolvers.set(resolver.provider, resolver);
  }

  providers(): string[] {
    return [...this.resolvers.keys()];
  }

  async check(raw: string): Promise<SecretCheck> {
    let ref: SecretRef;
    try {
      ref = parseSecretRef(raw);
    } catch (err) {
      return { ok: false, problem: (err as Error).message };
    }
    const resolver = this.resolvers.get(ref.provider);
    if (!resolver) {
      return {
        ok: false,
        problem: `unknown secret provider "${ref.provider}" (available: ${this.providers().join(', ')})`,
      };
    }
    return resolver.check(ref);
  }

  async resolve(raw: string): Promise<string> {
    const ref = parseSecretRef(raw);
    const resolver = this.resolvers.get(ref.provider);
    if (!resolver) {
      throw new TestLeaseError(
        ErrorCodes.SECRET_RESOLUTION_FAILED,
        `No secret resolver registered for provider "${ref.provider}"`,
        { ref: raw },
      );
    }
    return resolver.resolve(ref);
  }
}
