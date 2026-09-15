/**
 * Runs the built CLI (bin/testlease.js) as a real child process against a real server started
 * by the CLI itself (`testlease serve`). Requires `pnpm build`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', '..', 'bin', 'testlease.js');
const dist = join(here, '..', '..', 'dist', 'cli.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const SECRETS = {
  BUYER_01_PASSWORD: 'cli-secret-one-value',
  BUYER_02_PASSWORD: 'cli-secret-two-value',
};

function run(args: string[], env: Record<string, string>, input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

describe('testlease CLI', () => {
  let dir: string;
  let server: ChildProcess;
  let url = '';
  let env: Record<string, string>;

  beforeAll(async () => {
    if (!existsSync(dist)) throw new Error(`CLI not built (${dist}). Run pnpm build first.`);
    dir = mkdtempSync(join(tmpdir(), 'testlease-cli-'));
    const configPath = join(dir, 'testlease.yml');
    writeFileSync(
      configPath,
      `server:\n  host: 127.0.0.1\n  port: 0\n  db: ${join(dir, 'tl.db')}\n  logLevel: info\npools:\n  buyers:\n    defaultTtl: 2s\n    resources:\n      - id: buyer-01\n        tags: { region: nl }\n        metadata: { email: buyer01@example.test }\n        secrets: { password: env:BUYER_01_PASSWORD }\n      - id: buyer-02\n        tags: { region: be }\n        metadata: { email: buyer02@example.test }\n        secrets: { password: env:BUYER_02_PASSWORD }\n`,
    );
    server = spawn(process.execPath, [bin, 'serve', '--config', configPath, '--no-pretty'], {
      env: { ...process.env, ...SECRETS, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    url = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const onData = (d: Buffer) => {
        buf += d.toString();
        const m = /"url":"(http:\/\/[^"]+)"/.exec(buf);
        if (m) resolve(m[1]!);
      };
      server.stdout!.on('data', onData);
      server.stderr!.on('data', onData);
      server.on('exit', (code) => reject(new Error(`server exited early (${code}): ${buf}`)));
      setTimeout(() => reject(new Error(`server did not start: ${buf}`)), 15_000).unref();
    });
    env = { TESTLEASE_URL: url, TESTLEASE_OWNER: 'cli-test' };
  }, 30_000);

  afterAll(async () => {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('status and pools render tables', async () => {
    const status = await run(['status'], env);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/POOL\s+AVAILABLE\s+LEASED\s+QUARANTINED\s+TOTAL\s+WAITING/);
    expect(status.stdout).toMatch(/buyers\s+2\s+0\s+0\s+2\s+0/);
    const pools = await run(['pools', '--json'], env);
    expect(JSON.parse(pools.stdout)).toMatchObject({
      pools: [{ name: 'buyers', counts: { total: 2 } }],
    });
  });

  it('acquire → inspect → events → release, with ownership hints on mismatch', async () => {
    const acq = await run(
      ['acquire', 'buyers', '--tag', 'region=nl', '--purpose', 'cli smoke', '--json'],
      env,
    );
    expect(acq.code, acq.stderr).toBe(0);
    const { lease } = JSON.parse(acq.stdout) as { lease: { leaseId: string; resourceId: string } };
    expect(lease.resourceId).toBe('buyer-01');
    expect(acq.stdout).not.toContain('cli-secret');

    const inspect = await run(['inspect', 'buyers'], env);
    expect(inspect.stdout).toMatch(
      /buyer-01\s+LEASED\s+region=nl\s+cli-test\s+in 00:0\d\s+cli smoke/,
    );

    const events = await run(['events', lease.leaseId], env);
    expect(events.stdout).toMatch(/LEASE_ACQUIRED/);

    const wrongOwner = await run(['release', lease.leaseId, '--owner', 'someone-else'], env);
    expect(wrongOwner.code).toBe(1);
    expect(wrongOwner.stderr).toMatch(/Error LEASE_OWNERSHIP_MISMATCH/);
    expect(wrongOwner.stderr).toMatch(/hint: .*--owner/);
    expect(wrongOwner.stderr).toMatch(/--force/);

    const forced = await run(['release', lease.leaseId, '--owner', 'ops', '--force'], env);
    expect(forced.code, forced.stderr).toBe(0);
    expect(forced.stdout).toMatch(/released/);
    const again = await run(['release', lease.leaseId], env);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/already released/);
  });

  it('fails fast with exit code 3 and a diagnostic when the pool is exhausted', async () => {
    const a = await run(['acquire', 'buyers', '--tag', 'region=be', '--json'], env);
    const { lease } = JSON.parse(a.stdout) as { lease: { leaseId: string } };
    const b = await run(['acquire', 'buyers', '--tag', 'region=be'], env);
    expect(b.code).toBe(3);
    expect(b.stderr).toMatch(/Error POOL_EXHAUSTED/);
    expect(b.stderr).toMatch(/buyer-02\s+LEASED\s+owner=cli-test/);
    const none = await run(['acquire', 'buyers', '--tag', 'region=de'], env);
    expect(none.code).toBe(3);
    expect(none.stderr).toMatch(/NO_MATCHING_RESOURCE/);
    await run(['release', lease.leaseId], env);
  });

  it('exec injects lease env and secrets into the child, redacts output, and releases afterwards', async () => {
    const script = `
      const s = process.env.TESTLEASE_SECRET_PASSWORD;
      console.log('lease', process.env.TESTLEASE_LEASE_ID, 'resource', process.env.TESTLEASE_RESOURCE_ID);
      console.log('tag', process.env.TESTLEASE_TAG_REGION, 'meta', process.env.TESTLEASE_META_EMAIL);
      console.log('secret-length', s.length);
      console.log('leak attempt:', s);
      console.error('stderr leak attempt:', s + ' trailing');
      process.exit(7);
    `;
    const res = await run(
      ['exec', '--pool', 'buyers', '--tag', 'region=nl', '--', process.execPath, '-e', script],
      env,
    );
    expect(res.code).toBe(7); // child exit code propagates
    expect(res.stdout).toMatch(/lease lease_[a-z0-9]+ resource buyer-01/);
    expect(res.stdout).toMatch(/tag nl meta buyer01@example.test/);
    expect(res.stdout).toMatch(new RegExp(`secret-length ${SECRETS.BUYER_01_PASSWORD.length}`));
    expect(res.stdout).toContain('leak attempt: [REDACTED:password]');
    expect(res.stderr).toContain('stderr leak attempt: [REDACTED:password] trailing');
    expect(res.stdout + res.stderr).not.toContain(SECRETS.BUYER_01_PASSWORD);
    expect(res.stderr).toMatch(/lease lease_[a-z0-9]+ released/);
    const status = await run(['status', '--json'], env);
    expect(
      (JSON.parse(status.stdout) as { pools: { counts: { leased: number } }[] }).pools[0]!.counts
        .leased,
    ).toBe(0);
  });

  it('doctor reports config, secrets and connectivity', async () => {
    const ok = await run(['doctor', '--config', join(dir, 'testlease.yml')], {
      ...env,
      ...SECRETS,
    });
    expect(ok.code, ok.stderr + ok.stdout).toBe(0);
    expect(ok.stdout).toMatch(/PASS\s+config file/);
    expect(ok.stdout).toMatch(/PASS\s+secret references/);
    expect(ok.stdout).toMatch(/PASS\s+server/);
    expect(ok.stdout).toMatch(/PASS\s+authentication\s+principal=local/);

    const missing = await run(['doctor', '--config', join(dir, 'testlease.yml'), '--no-server'], {
      ...env,
      BUYER_02_PASSWORD: '',
    });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toMatch(
      /FAIL\s+secret reference\s+buyers\/buyer-02\.password -> env:BUYER_02_PASSWORD/,
    );
    expect(missing.stdout).not.toContain('cli-secret');

    const down = await run(['doctor', '--no-color'], { TESTLEASE_URL: 'http://127.0.0.1:1' });
    expect(down.code).toBe(1);
    expect(down.stdout).toMatch(/FAIL\s+server\s+http:\/\/127.0.0.1:1/);
  });

  it('validate checks a config file without a server and rejects duplicates', async () => {
    const bad = join(dir, 'bad.yml');
    writeFileSync(
      bad,
      `pools:\n  a:\n    resources: [{ id: x }]\n  b:\n    resources: [{ id: x }]\n`,
    );
    const res = await run(['validate', '--config', bad], env);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/FAIL\s+config file.*defined twice/);
  });

  it('serve refuses a non-loopback bind without tokens', async () => {
    const cfg = join(dir, 'insecure.yml');
    writeFileSync(cfg, `server:\n  host: 0.0.0.0\n  port: 0\n  db: ':memory:'\npools: {}\n`);
    const res = await run(['serve', '--config', cfg, '--no-pretty'], {});
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/Refusing to bind 0.0.0.0 without authentication/);
  });
});
