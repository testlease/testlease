/**
 * `testlease exec --lease` run by a runner token for a lease another token (the agent) acquired.
 * Spawns the built CLI against a real `testlease serve`, like cli.test.ts. Requires `pnpm build`.
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
  BUYER_01_PASSWORD: 'delegated-secret-one-value',
  TOKEN_AGENT: 'agent-token-value-0123456789abcdef',
  TOKEN_RUNNER: 'runner-token-value-0123456789abcdef',
  TOKEN_STRANGER: 'stranger-token-value-0123456789abcdef',
};

const AGENT_OWNER = 'agent:alpha/task-1';

/** process.env without TESTLEASE_* so a developer's shell cannot change what is tested. */
function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('TESTLEASE_')) out[k] = v;
  }
  return out;
}

function run(args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...cleanEnv(), NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// Prints only facts about the secret, never the value itself.
const PROBE = `
  const s = process.env.TESTLEASE_SECRET_PASSWORD;
  console.log('lease', process.env.TESTLEASE_LEASE_ID);
  console.log('secret-present', s !== undefined, 'secret-length', s ? s.length : 0);
`;

describe('testlease exec --lease with a delegate token', () => {
  let dir: string;
  let server: ChildProcess;
  let url = '';
  const as = (tokenValue: string, owner: string) => ({
    TESTLEASE_URL: url,
    TESTLEASE_TOKEN: tokenValue,
    TESTLEASE_OWNER: owner,
  });
  const agentEnv = () => as(SECRETS.TOKEN_AGENT, AGENT_OWNER);

  async function agentAcquire(): Promise<string> {
    const res = await run(['acquire', 'buyers', '--json'], agentEnv());
    expect(res.code).toBe(0);
    return (JSON.parse(res.stdout) as { lease: { leaseId: string } }).lease.leaseId;
  }

  async function leaseState(leaseId: string): Promise<string> {
    const res = await run(['leases', '--state', 'all', '--json'], agentEnv());
    const leases = (JSON.parse(res.stdout) as { leases: { leaseId: string; state: string }[] })
      .leases;
    return leases.find((l) => l.leaseId === leaseId)!.state;
  }

  beforeAll(async () => {
    if (!existsSync(dist)) throw new Error(`CLI not built (${dist}). Run pnpm build first.`);
    dir = mkdtempSync(join(tmpdir(), 'testlease-cli-delegation-'));
    const configPath = join(dir, 'testlease.yml');
    writeFileSync(
      configPath,
      [
        'server:',
        '  host: 127.0.0.1',
        '  port: 0',
        `  db: ${join(dir, 'tl.db')}`,
        '  logLevel: info',
        'auth:',
        '  tokens:',
        '    - { name: agent, token: env:TOKEN_AGENT, scopes: [lease:read, lease:write, pool:read] }',
        '    - { name: runner, token: env:TOKEN_RUNNER, scopes: [lease:read, lease:write, secrets:resolve], delegateFor: [agent] }',
        '    - { name: stranger, token: env:TOKEN_STRANGER, scopes: [lease:read, lease:write, secrets:resolve] }',
        'pools:',
        '  buyers:',
        '    defaultTtl: 30s',
        '    resources:',
        '      - id: buyer-01',
        '        secrets: { password: env:BUYER_01_PASSWORD }',
        '',
      ].join('\n'),
    );
    server = spawn(process.execPath, [bin, 'serve', '--config', configPath, '--no-pretty'], {
      env: { ...cleanEnv(), ...SECRETS, NO_COLOR: '1' },
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
  }, 30_000);

  afterAll(async () => {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs the command with TESTLEASE_SECRET_* for a lease acquired by another token', async () => {
    const leaseId = await agentAcquire();
    const res = await run(
      ['exec', '--lease', leaseId, '--', process.execPath, '-e', PROBE],
      as(SECRETS.TOKEN_RUNNER, 'runner-host'),
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`lease ${leaseId}`);
    expect(res.stdout).toContain(
      `secret-present true secret-length ${SECRETS.BUYER_01_PASSWORD.length}`,
    );
    expect(res.stderr).not.toMatch(/Secrets not injected/);
    expect(res.stdout + res.stderr).not.toContain(SECRETS.BUYER_01_PASSWORD);
  });

  it('releases the lease when the command exits (and keeps it with --keep)', async () => {
    const released = await agentAcquire();
    const r1 = await run(
      ['exec', '--lease', released, '--', process.execPath, '-e', PROBE],
      as(SECRETS.TOKEN_RUNNER, 'runner-host'),
    );
    expect(r1.code).toBe(0);
    expect(r1.stderr).toMatch(new RegExp(`lease ${released} released`));
    expect(await leaseState(released)).toBe('RELEASED');

    const kept = await agentAcquire();
    const r2 = await run(
      ['exec', '--lease', kept, '--keep', '--', process.execPath, '-e', PROBE],
      as(SECRETS.TOKEN_RUNNER, 'runner-host'),
    );
    expect(r2.code).toBe(0);
    expect(r2.stderr).toMatch(new RegExp(`lease ${kept} kept`));
    expect(await leaseState(kept)).toBe('ACTIVE');
    expect((await run(['release', kept], agentEnv())).code).toBe(0);
  });

  it('does not inject secrets when the token has no delegateFor for the lease principal', async () => {
    // exec keeps its existing behaviour: it warns and runs the command without secrets.
    const leaseId = await agentAcquire();
    const res = await run(
      ['exec', '--lease', leaseId, '--', process.execPath, '-e', PROBE],
      as(SECRETS.TOKEN_STRANGER, 'runner-host'),
    );
    expect(res.stderr).toMatch(/Secrets not injected: LEASE_OWNERSHIP_MISMATCH/);
    expect(res.stdout).toContain('secret-present false');
    expect(res.stdout + res.stderr).not.toContain(SECRETS.BUYER_01_PASSWORD);
    // The stranger could not release it either; the agent still owns it.
    expect(await leaseState(leaseId)).toBe('ACTIVE');
    expect((await run(['release', leaseId], agentEnv())).code).toBe(0);
  });
});
