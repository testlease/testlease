import { spawn } from 'node:child_process';
import { Transform, type TransformCallback } from 'node:stream';
import type { Command } from 'commander';
import type { TestLeaseError } from '@testlease/protocol';
import { parseDuration } from '@testlease/core';
import type { Lease } from '@testlease/client';
import type { CliContext } from '../context.js';
import { EXIT, parseKeyValues, reportError } from '../output.js';

/** Replaces every occurrence of each secret value with a marker. Best effort; see docs/exec.md. */
export class Redactor extends Transform {
  private readonly secrets: { value: string; marker: string }[];
  private carry = '';
  private readonly maxLen: number;

  constructor(secrets: Record<string, string>) {
    super();
    this.secrets = Object.entries(secrets)
      .filter(([, v]) => v.length >= 4)
      .map(([k, v]) => ({ value: v, marker: `[REDACTED:${k}]` }))
      .sort((a, b) => b.value.length - a.value.length);
    this.maxLen = Math.max(0, ...this.secrets.map((s) => s.value.length));
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s.value).join(s.marker);
    return out;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    // Redact the whole buffered text first, then hold back a tail that could still be the
    // beginning of a secret continued in the next chunk. (Holding back the *raw* tail and
    // redacting only the emitted part let a secret straddling the boundary through — see
    // test/unit/redactor.test.ts for the reproduction.)
    const redacted = this.redact(this.carry + chunk.toString('utf8'));
    const keep = this.maxLen > 0 ? Math.min(this.maxLen - 1, redacted.length) : 0;
    this.carry = redacted.slice(redacted.length - keep);
    cb(null, redacted.slice(0, redacted.length - keep));
  }

  override _flush(cb: TransformCallback): void {
    cb(null, this.redact(this.carry));
    this.carry = '';
  }
}

export function envKey(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts]
    .join('_')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toUpperCase();
}

export function buildLeaseEnv(
  lease: Lease,
  secrets: Record<string, string> | null,
  prefix: string,
  url: string,
): Record<string, string> {
  const env: Record<string, string> = {
    [envKey(prefix, 'URL')]: url,
    [envKey(prefix, 'LEASE_ID')]: lease.leaseId,
    [envKey(prefix, 'RESOURCE_ID')]: lease.resourceId,
    [envKey(prefix, 'POOL')]: lease.pool,
    [envKey(prefix, 'OWNER')]: lease.owner,
    [envKey(prefix, 'EXPIRES_AT')]: new Date(lease.expiresAt).toISOString(),
  };
  for (const [k, v] of Object.entries(lease.resource.tags)) env[envKey(prefix, 'TAG', k)] = v;
  for (const [k, v] of Object.entries(lease.resource.metadata))
    env[envKey(prefix, 'META', k)] = String(v);
  if (secrets) for (const [k, v] of Object.entries(secrets)) env[envKey(prefix, 'SECRET', k)] = v;
  return env;
}

export function registerExecCommand(program: Command, getCtx: () => CliContext): void {
  program
    .command('exec')
    .description(
      'Acquire a lease (or attach to one), run a command with lease details and secrets in its environment, then release',
    )
    .option('--pool <pool>', 'acquire from this pool')
    .option('--lease <lease-id>', 'use an existing lease you own instead of acquiring')
    .option('-t, --tag <key=value...>', 'required tags (repeatable)')
    .option('--ttl <duration>', 'lease TTL (default: pool default)')
    .option('-w, --wait <duration>', 'how long to wait for a free resource (default: 0)')
    .option('-p, --purpose <text>', 'why this lease exists')
    .option('--no-secrets', 'do not resolve secrets into the environment')
    .option('--no-redact', 'do not redact secret values in the child output')
    .option('--env-prefix <prefix>', 'environment variable prefix', 'TESTLEASE')
    .option('--keep', 'do not release the lease when the command exits')
    .argument('<command...>', 'command to run (put -- before it)')
    .allowExcessArguments(true)
    .action(
      async (
        command: string[],
        opts: {
          pool?: string;
          lease?: string;
          tag?: string[];
          ttl?: string;
          wait?: string;
          purpose?: string;
          secrets: boolean;
          redact: boolean;
          envPrefix: string;
          keep?: boolean;
        },
      ) => {
        const ctx = getCtx();
        const { out } = ctx;
        if (!opts.pool === !opts.lease) {
          out.err('Provide exactly one of --pool <pool> or --lease <lease-id>.');
          process.exitCode = EXIT.USAGE;
          return;
        }
        if (command.length === 0) {
          out.err('Provide a command to run after --.');
          process.exitCode = EXIT.USAGE;
          return;
        }
        const client = ctx.client();
        let lease: Lease;
        try {
          lease = opts.lease
            ? await client.attach(opts.lease, { heartbeat: true })
            : await client.acquireLease({
                pool: opts.pool!,
                tags: parseKeyValues(opts.tag, 'tag'),
                ...(opts.ttl ? { ttlMs: parseDuration(opts.ttl) } : {}),
                ...(opts.wait ? { waitTimeoutMs: parseDuration(opts.wait) } : {}),
                purpose: opts.purpose ?? `testlease exec: ${command.join(' ')}`.slice(0, 500),
                heartbeat: {
                  onError: (e) =>
                    out.err(
                      out.paint('yellow', `heartbeat: ${(e as TestLeaseError).code ?? e.message}`),
                    ),
                },
              });
        } catch (err) {
          process.exitCode = reportError(out, err);
          return;
        }
        if (lease.state !== 'ACTIVE') {
          out.err(`Lease ${lease.leaseId} is ${lease.state}; refusing to run.`);
          process.exitCode = EXIT.ERROR;
          return;
        }

        let secrets: Record<string, string> | null = null;
        if (opts.secrets && lease.resource.secretKeys.length) {
          try {
            secrets = await lease.secrets();
          } catch (err) {
            out.err(
              out.paint(
                'yellow',
                `Secrets not injected: ${(err as TestLeaseError).code ?? (err as Error).message}`,
              ),
            );
          }
        }
        out.err(
          out.paint(
            'dim',
            `testlease: lease ${lease.leaseId} on ${lease.resourceId} (${lease.pool}); secrets: ${secrets ? Object.keys(secrets).sort().join(', ') || 'none' : 'not injected'}`,
          ),
        );

        const childEnv = { ...ctx.env, ...buildLeaseEnv(lease, secrets, opts.envPrefix, ctx.url) };
        const redact = opts.redact && secrets && Object.keys(secrets).length > 0;
        const child = spawn(command[0]!, command.slice(1), {
          env: childEnv,
          stdio: ['inherit', redact ? 'pipe' : 'inherit', redact ? 'pipe' : 'inherit'],
        });
        if (redact) {
          child.stdout!.pipe(new Redactor(secrets!)).pipe(process.stdout);
          child.stderr!.pipe(new Redactor(secrets!)).pipe(process.stderr);
        }

        const forward = (sig: NodeJS.Signals) => () => {
          if (!child.killed) child.kill(sig);
        };
        const onInt = forward('SIGINT');
        const onTerm = forward('SIGTERM');
        process.on('SIGINT', onInt);
        process.on('SIGTERM', onTerm);

        const exitCode: number = await new Promise((resolve) => {
          child.on('error', (err) => {
            out.err(`Failed to start "${command[0]}": ${err.message}`);
            resolve(127);
          });
          child.on('close', (code, signal) => resolve(code ?? (signal ? 128 + 15 : 1)));
        });
        process.off('SIGINT', onInt);
        process.off('SIGTERM', onTerm);

        if (opts.keep) {
          lease.stopHeartbeat();
          out.err(
            out.paint(
              'dim',
              `testlease: lease ${lease.leaseId} kept (release with: testlease release ${lease.leaseId})`,
            ),
          );
        } else {
          try {
            const rel = await lease.release();
            out.err(
              out.paint(
                'dim',
                `testlease: lease ${lease.leaseId} ${rel.outcome.replace('_', ' ')}`,
              ),
            );
          } catch (err) {
            out.err(
              out.paint(
                'yellow',
                `testlease: release failed: ${(err as Error).message}; the lease expires on its own.`,
              ),
            );
          }
        }
        process.exitCode = exitCode;
      },
    );
}
