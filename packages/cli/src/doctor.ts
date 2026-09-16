import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { TestLeaseError } from '@testlease/protocol';
import {
  checkSecretRefs,
  ConfigError,
  loadConfigFile,
  SecretResolverRegistry,
  applyEnvOverrides,
  type TestLeaseConfig,
} from '@testlease/core';
import type { CliContext } from './context.js';
import { EXIT } from './output.js';

type Level = 'ok' | 'warn' | 'fail';
interface Finding {
  level: Level;
  check: string;
  detail: string;
}

function mark(ctx: CliContext, level: Level): string {
  const { out } = ctx;
  return level === 'ok'
    ? out.paint('green', 'PASS')
    : level === 'warn'
      ? out.paint('yellow', 'WARN')
      : out.paint('red', 'FAIL');
}

function print(ctx: CliContext, findings: Finding[]): number {
  if (ctx.out.opts.json) {
    ctx.out.json({ findings });
  } else {
    for (const f of findings)
      ctx.out.line(`${mark(ctx, f.level)}  ${ctx.out.paint('bold', f.check)}  ${f.detail}`);
    const fails = findings.filter((f) => f.level === 'fail').length;
    const warns = findings.filter((f) => f.level === 'warn').length;
    ctx.out.line();
    ctx.out.line(
      fails
        ? ctx.out.paint(['red', 'bold'], `${fails} problem(s), ${warns} warning(s)`)
        : ctx.out.paint(
            ['green', 'bold'],
            `All checks passed${warns ? ` (${warns} warning(s))` : ''}`,
          ),
    );
  }
  return findings.some((f) => f.level === 'fail') ? EXIT.ERROR : EXIT.OK;
}

async function checkConfig(
  ctx: CliContext,
  path: string | undefined,
  findings: Finding[],
): Promise<TestLeaseConfig | null> {
  const resolved = path ?? ctx.env.TESTLEASE_CONFIG ?? './testlease.yml';
  if (!existsSync(resolved)) {
    findings.push({
      level: path || ctx.env.TESTLEASE_CONFIG ? 'fail' : 'warn',
      check: 'config file',
      detail: `${resolve(resolved)} not found${path ? '' : ' (pass --config <path> to check a file)'}`,
    });
    return null;
  }
  try {
    const loaded = loadConfigFile(resolved);
    const config = applyEnvOverrides(loaded.config, ctx.env);
    const pools = Object.keys(config.pools);
    const resources = Object.values(config.pools).reduce((n, p) => n + p.resources.length, 0);
    findings.push({
      level: 'ok',
      check: 'config file',
      detail: `${resolve(resolved)}: ${pools.length} pool(s), ${resources} resource(s)`,
    });
    for (const w of loaded.warnings) findings.push({ level: 'warn', check: 'config', detail: w });

    const problems = await checkSecretRefs(config, new SecretResolverRegistry());
    if (problems.length) {
      for (const p of problems)
        findings.push({
          level: 'fail',
          check: 'secret reference',
          detail: `${p.pool}/${p.resourceId}.${p.secretName} -> ${p.ref}: ${p.problem}`,
        });
    } else {
      const total = Object.values(config.pools).reduce(
        (n, p) => n + p.resources.reduce((m, r) => m + Object.keys(r.secrets).length, 0),
        0,
      );
      findings.push({
        level: 'ok',
        check: 'secret references',
        detail: `${total} reference(s) resolvable in this environment (values not shown)`,
      });
    }

    if (config.server.db !== ':memory:') {
      const dbPath = resolve(config.server.db);
      const dir = dirname(dbPath);
      try {
        accessSync(existsSync(dbPath) ? dbPath : dir, constants.W_OK);
        findings.push({
          level: 'ok',
          check: 'database path',
          detail: `${dbPath}${existsSync(dbPath) ? ` (${statSync(dbPath).size} bytes)` : ' (will be created)'}`,
        });
      } catch {
        findings.push({
          level: 'fail',
          check: 'database path',
          detail: `${dbPath} is not writable`,
        });
      }
    } else {
      findings.push({
        level: 'warn',
        check: 'database path',
        detail: ':memory: — leases will not survive a restart',
      });
    }

    const loopback = /^(127\.|localhost$|::1$|\[::1\]$)/.test(config.server.host);
    if (!loopback && config.auth.tokens.length === 0) {
      findings.push({
        level: config.server.allowInsecureRemote ? 'warn' : 'fail',
        check: 'network exposure',
        detail: `host ${config.server.host} without tokens${config.server.allowInsecureRemote ? ' (allowInsecureRemote is set)' : ' — the server will refuse to start'}`,
      });
    } else {
      findings.push({
        level: 'ok',
        check: 'network exposure',
        detail: loopback
          ? `bound to loopback (${config.server.host})`
          : `${config.server.host} with ${config.auth.tokens.length} token(s)`,
      });
    }
    return config;
  } catch (err) {
    findings.push({
      level: 'fail',
      check: 'config file',
      detail:
        err instanceof ConfigError ? err.message.replace(/\n\s*/g, ' ') : (err as Error).message,
    });
    return null;
  }
}

async function checkServer(ctx: CliContext, findings: Finding[]): Promise<void> {
  const client = ctx.client();
  let health;
  try {
    health = await client.health();
  } catch (err) {
    findings.push({
      level: 'fail',
      check: 'server',
      detail: `${ctx.url}: ${(err as TestLeaseError).message.replace(/ Try: testlease doctor$/, '')} Start one with \`testlease serve\`, or point --url / TESTLEASE_URL at a running server.`,
    });
    return;
  }
  findings.push({
    level: health.status === 'ok' ? 'ok' : 'warn',
    check: 'server',
    detail: `${ctx.url} v${health.version} ${health.status} (auth=${health.auth.mode}, schema v${health.db.schemaVersion}, mcp/http=${health.mcp.http ? 'on' : 'off'})`,
  });
  const skew = Math.abs(health.now - Date.now());
  findings.push({
    level: skew > 30_000 ? 'warn' : 'ok',
    check: 'clock skew',
    detail: `${skew}ms between this machine and the server${skew > 30_000 ? ' — TTL displays will look off; leasing itself uses the server clock' : ''}`,
  });

  try {
    const who = await client.whoami();
    findings.push({
      level: 'ok',
      check: 'authentication',
      detail: `principal=${who.principal} scopes=${who.scopes.join(',')}`,
    });
    for (const s of ['lease:write', 'pool:read'] as const) {
      if (!who.scopes.includes(s))
        findings.push({ level: 'warn', check: 'scopes', detail: `token lacks ${s}` });
    }
    if (!who.scopes.includes('secrets:resolve'))
      findings.push({
        level: 'warn',
        check: 'scopes',
        detail:
          'token lacks secrets:resolve — lease.secrets() and `testlease exec` cannot inject credentials',
      });
  } catch (err) {
    const e = err as TestLeaseError;
    findings.push({
      level: 'fail',
      check: 'authentication',
      detail:
        e.code === 'UNAUTHORIZED' ? `${e.message} (set --token or TESTLEASE_TOKEN)` : e.message,
    });
    return;
  }
  try {
    const pools = await client.listPools();
    findings.push({
      level: pools.length ? 'ok' : 'warn',
      check: 'pools',
      detail: pools.length
        ? pools
            .map(
              (p) =>
                `${p.name}(${p.counts.available}/${p.counts.total} available${p.counts.quarantined ? `, ${p.counts.quarantined} quarantined` : ''})`,
            )
            .join(' ')
        : 'no pools configured on the server',
    });
  } catch (err) {
    findings.push({ level: 'fail', check: 'pools', detail: (err as Error).message });
  }
}

export async function runDoctor(
  ctx: CliContext,
  opts: { config?: string; skipServer?: boolean },
): Promise<number> {
  const findings: Finding[] = [];
  const [major] = process.versions.node.split('.').map(Number);
  findings.push({
    level: (major ?? 0) >= 22 ? 'ok' : 'fail',
    check: 'node',
    detail: `v${process.versions.node}${(major ?? 0) >= 22 ? '' : ' — TestLease requires Node 22.12 or newer'}`,
  });
  await checkConfig(ctx, opts.config, findings);
  if (!opts.skipServer) await checkServer(ctx, findings);
  return print(ctx, findings);
}

export async function runValidate(ctx: CliContext, path: string | undefined): Promise<number> {
  const findings: Finding[] = [];
  const config = await checkConfig(ctx, path ?? './testlease.yml', findings);
  if (config && !ctx.out.opts.json) {
    ctx.out.line();
    ctx.out.table([
      ['POOL', 'RESOURCES', 'DEFAULT TTL', 'MAX TTL'],
      ...Object.entries(config.pools).map(([name, p]) => [
        name,
        String(p.resources.length),
        `${p.defaultTtl / 1000}s`,
        `${p.maxTtl / 1000}s`,
      ]),
    ]);
    ctx.out.line();
  }
  return print(ctx, findings);
}
