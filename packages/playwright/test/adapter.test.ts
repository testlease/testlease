/**
 * Runs real Playwright (the `playwright test` CLI, Chromium headless) against a real TestLease
 * server with the built adapter. Requires `pnpm build` and a Playwright Chromium install.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestLease,
  EnvSecretResolver,
  noopLogger,
  validateConfig,
  type TestLeaseEngine,
} from '@testlease/core';
import { startServer, type RunningServer } from '@testlease/server';
import { TestLeaseClient } from '@testlease/client';

const here = dirname(fileURLToPath(import.meta.url));
const project = join(here, 'fixtures', 'pw-project');
const dist = join(here, '..', 'dist', 'index.js');
const pwBin = join(here, '..', 'node_modules', '.bin', 'playwright');

const SECRETS = {
  ACC_1: 'acc-one-secret-value',
  ACC_2: 'acc-two-secret-value',
  ACC_3: 'acc-three-secret-value',
  CRASH: 'crash-secret-value',
};

interface PwResult {
  code: number;
  stdout: string;
  stderr: string;
  report: PwReport;
}
interface PwReport {
  stats: { expected: number; unexpected: number; flaky: number; skipped: number };
  suites: PwSuite[];
}
interface PwSuite {
  suites?: PwSuite[];
  specs?: {
    title: string;
    tests: {
      results: {
        status: string;
        attachments: { name: string; body?: string; path?: string; contentType: string }[];
      }[];
    }[];
  }[];
}

function specs(report: PwReport): NonNullable<PwSuite['specs']> {
  const out: NonNullable<PwSuite['specs']> = [];
  const walk = (s: PwSuite) => {
    out.push(...(s.specs ?? []));
    (s.suites ?? []).forEach(walk);
  };
  report.suites.forEach(walk);
  return out;
}

function evidenceAttachments(report: PwReport): { title: string; evidence: EvidenceBody }[] {
  const out: { title: string; evidence: EvidenceBody }[] = [];
  for (const spec of specs(report)) {
    for (const t of spec.tests) {
      for (const r of t.results) {
        for (const a of r.attachments) {
          if (a.name !== 'testlease.json') continue;
          const text = a.body
            ? Buffer.from(a.body, 'base64').toString('utf8')
            : readFileSync(a.path!, 'utf8');
          out.push({ title: spec.title, evidence: JSON.parse(text) as EvidenceBody });
        }
      }
    }
  }
  return out;
}

interface EvidenceBody {
  test: { title: string; status: string };
  worker: { parallelIndex: number };
  leases: {
    fixture: string;
    scope: string;
    leaseId: string;
    resourceId: string;
    owner: string;
    ownerParts: { runId: string; project: string; worker: string };
    state: string;
    expiredDuringUse: boolean;
    heartbeat: { healthy: boolean; renewals: number };
    tookOver: boolean;
    reacquired: boolean;
    secretsResolved: boolean;
    waitedMs: number;
  }[];
}

function runPlaywright(
  args: string[],
  env: Record<string, string>,
  dir: string,
): Promise<PwResult> {
  const reportPath = join(dir, `report-${args.join('-').replace(/[^a-z0-9-]/gi, '_')}.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(pwBin, ['test', ...args], {
      cwd: project,
      env: {
        ...process.env,
        ...env,
        PW_JSON_REPORT: reportPath,
        PW_OUTPUT_DIR: join(dir, 'pw-output'),
        CI: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      let report: PwReport = {
        stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
        suites: [],
      };
      if (existsSync(reportPath)) report = JSON.parse(readFileSync(reportPath, 'utf8')) as PwReport;
      resolve({ code: code ?? -1, stdout, stderr, report });
    });
  });
}

describe('@testlease/playwright against real Playwright workers', () => {
  let dir: string;
  let engine: TestLeaseEngine;
  let server: RunningServer;
  let env: Record<string, string>;
  let admin: TestLeaseClient;

  beforeAll(async () => {
    if (!existsSync(dist)) throw new Error(`Adapter not built (${dist}); run pnpm build`);
    if (!existsSync(pwBin)) throw new Error(`playwright binary not found at ${pwBin}`);
    dir = mkdtempSync(join(tmpdir(), 'testlease-pw-'));
    const { config } = validateConfig(
      {
        server: {
          host: '127.0.0.1',
          port: 0,
          db: join(dir, 'tl.db'),
          logLevel: 'silent',
          maxWait: '2m',
        },
        pools: {
          accounts: {
            defaultTtl: '10s',
            resources: [1, 2, 3].map((i) => ({
              id: `acct-${i}`,
              tags: { region: 'nl' },
              metadata: { email: `acct${i}@example.test` },
              secrets: { password: `env:ACC_${i}` },
            })),
          },
          crashpool: {
            defaultTtl: '3s',
            resources: [
              {
                id: 'crash-1',
                metadata: { email: 'crash@example.test' },
                secrets: { password: 'env:CRASH' },
              },
            ],
          },
          qpool: {
            defaultTtl: '10s',
            resources: [1, 2, 3].map((i) => ({
              id: `q-${i}`,
              metadata: { email: `q${i}@example.test` },
              secrets: { password: `env:ACC_${i}` },
            })),
          },
          scratch: {
            defaultTtl: '10s',
            resources: [1, 2].map((i) => ({
              id: `scratch-${i}`,
              metadata: { note: 'no secrets here' },
            })),
          },
        },
      },
      '<pw-test>',
    );
    engine = await createTestLease({
      config,
      logger: noopLogger,
      secretResolvers: [new EnvSecretResolver(SECRETS)],
      version: 'test',
    });
    server = await startServer({ engine, logger: noopLogger, port: 0 });
    admin = new TestLeaseClient({ baseUrl: server.url, owner: 'vitest' });
    env = { TESTLEASE_URL: server.url, TESTLEASE_RUN_ID: 'run-pw-1' };
  }, 60_000);

  afterAll(async () => {
    await server?.close({ timeoutMs: 1000 });
    rmSync(dir, { recursive: true, force: true });
  });

  it('8 workers share 3 accounts across 24 tests: no overlap, everyone waits their turn, everything is returned, evidence attached', async () => {
    const usageLog = join(dir, 'usage.jsonl');
    const res = await runPlaywright(['--project=parallel'], { ...env, USAGE_LOG: usageLog }, dir);
    expect(res.code, res.stdout + res.stderr).toBe(0);
    expect(res.report.stats.expected).toBe(24);
    expect(res.report.stats.unexpected).toBe(0);

    // 1. Application-level: usage intervals recorded by the tests never overlap per account.
    const usage = readFileSync(usageLog, 'utf8')
      .trim()
      .split('\n')
      .map(
        (l) =>
          JSON.parse(l) as {
            resourceId: string;
            leaseId: string;
            start: number;
            end: number;
            worker: number;
          },
      );
    expect(usage).toHaveLength(24);
    const byResource = new Map<string, typeof usage>();
    for (const u of usage)
      byResource.set(u.resourceId, [...(byResource.get(u.resourceId) ?? []), u]);
    expect([...byResource.keys()].sort()).toEqual(['acct-1', 'acct-2', 'acct-3']);
    for (const [rid, list] of byResource) {
      const sorted = [...list].sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) {
        // Different leases on the same account must not overlap in time. Same-lease overlaps are
        // impossible here (one worker runs one test at a time).
        if (sorted[i]!.leaseId !== sorted[i - 1]!.leaseId) {
          expect(
            sorted[i]!.start,
            `${rid}: ${sorted[i]!.leaseId} started before ${sorted[i - 1]!.leaseId} ended`,
          ).toBeGreaterThanOrEqual(sorted[i - 1]!.end);
        }
      }
    }

    // 2. Server-level: the event log shows strictly alternating acquire/release per resource.
    const { events } = await admin.listRecentEvents(1000);
    const active = new Map<string, string>();
    let acquisitions = 0;
    let waited = 0;
    for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
      if (!e.resourceId?.startsWith('acct-')) continue;
      if (e.type === 'LEASE_ACQUIRED') {
        expect(active.has(e.resourceId), `${e.resourceId} double-leased at seq ${e.seq}`).toBe(
          false,
        );
        active.set(e.resourceId, e.leaseId!);
        acquisitions++;
        if ((e.details?.waitedMs as number) > 0) waited++;
      } else if (e.type === 'LEASE_RELEASED' || e.type === 'LEASE_EXPIRED') {
        expect(active.get(e.resourceId)).toBe(e.leaseId);
        active.delete(e.resourceId);
      }
    }
    expect(active.size).toBe(0); // all resources returned
    // 8 workers but only 3 accounts: 8 worker-scoped acquisitions, at least 5 had to wait.
    expect(acquisitions).toBe(8);
    expect(waited).toBeGreaterThanOrEqual(5);
    expect(
      events.filter((e) => e.type === 'LEASE_EXPIRED' && e.resourceId?.startsWith('acct-')),
    ).toHaveLength(0);
    const pool = await admin.getPool('accounts');
    expect(pool.counts).toMatchObject({ available: 3, leased: 0, quarantined: 0 });
    expect(pool.waiting).toBe(0);

    // 3. Evidence: every test has a sanitized testlease.json with the lease it ran on.
    const evidence = evidenceAttachments(res.report);
    expect(evidence).toHaveLength(24);
    for (const { evidence: ev } of evidence) {
      expect(ev.leases).toHaveLength(1);
      const lease = ev.leases[0]!;
      expect(lease.fixture).toBe('buyer');
      expect(lease.scope).toBe('worker');
      expect(['acct-1', 'acct-2', 'acct-3']).toContain(lease.resourceId);
      expect(lease.owner).toMatch(/^run-pw-1\/parallel\/worker-\d+$/);
      expect(lease.ownerParts).toMatchObject({ runId: 'run-pw-1', project: 'parallel' });
      expect(lease.secretsResolved).toBe(true);
      expect(lease.expiredDuringUse).toBe(false);
      const text = JSON.stringify(ev);
      for (const s of Object.values(SECRETS)) expect(text).not.toContain(s);
      expect(text).not.toContain('env:ACC'); // not even secret references
    }
    const workersSeen = new Set(evidence.map((e) => e.evidence.worker.parallelIndex));
    expect(workersSeen.size).toBe(8);
  }, 180_000);

  it('a killed worker never releases; the TTL reclaims its resource', async () => {
    const leaseFile = join(dir, 'crash-lease.json');
    const res = await runPlaywright(
      ['--project=crash'],
      { ...env, TESTLEASE_POOL: 'crashpool', CRASH_LEASE_FILE: leaseFile },
      dir,
    );
    expect(res.code).not.toBe(0); // Playwright reports the crashed worker
    expect(existsSync(leaseFile)).toBe(true);
    const { leaseId, resourceId } = JSON.parse(readFileSync(leaseFile, 'utf8')) as {
      leaseId: string;
      resourceId: string;
    };
    expect(resourceId).toBe('crash-1');

    const rightAfter = await admin.getLease(leaseId);
    // Either still ACTIVE (teardown never ran) or, if Playwright took long to exit, already expired.
    expect(['ACTIVE', 'EXPIRED']).toContain(rightAfter.state);
    expect(rightAfter.endReason ?? 'EXPIRED').toBe('EXPIRED'); // never RELEASED

    const deadline = Date.now() + 8_000;
    let view = rightAfter;
    while (view.state === 'ACTIVE' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      view = await admin.getLease(leaseId);
    }
    expect(view.state).toBe('EXPIRED');
    expect(view.endReason).toBe('EXPIRED');
    expect((await admin.getResource('crash-1')).state).toBe('AVAILABLE');
    const { events } = await admin.listLeaseEvents(leaseId);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['LEASE_ACQUIRED', 'LEASE_EXPIRED']),
    );
    expect(events.map((e) => e.type)).not.toContain('LEASE_RELEASED');
  }, 120_000);

  it('quarantine from a test ends the lease and the worker receives a replacement for the next test', async () => {
    const qLog = join(dir, 'q.jsonl');
    const res = await runPlaywright(
      ['--project=quarantine'],
      { ...env, TESTLEASE_POOL: 'qpool', Q_LOG: qLog },
      dir,
    );
    expect(res.code, res.stdout + res.stderr).toBe(0);
    const lines = readFileSync(qLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { test: number; resourceId: string; leaseId: string });
    expect(lines).toHaveLength(2);
    expect(lines[0]!.resourceId).not.toBe(lines[1]!.resourceId);
    expect(lines[0]!.leaseId).not.toBe(lines[1]!.leaseId);
    const quarantined = await admin.getResource(lines[0]!.resourceId);
    expect(quarantined.state).toBe('QUARANTINED');
    expect(quarantined.quarantine?.reason).toBe('account locked by fraud check');
    const pool = await admin.getPool('qpool');
    expect(pool.counts).toMatchObject({ quarantined: 1, leased: 0, available: 2 });

    const evidence = evidenceAttachments(res.report);
    expect(evidence).toHaveLength(2);
    const second = evidence.find((e) => e.title.startsWith('second'))!;
    expect(second.evidence.leases[0]!.reacquired).toBe(true);
    const first = evidence.find((e) => e.title.startsWith('first'))!;
    expect(first.evidence.leases[0]!.state).toBe('RELEASED');
  }, 120_000);

  it('test-scoped leases: one lease per test, released after each, 4 workers on 2 resources', async () => {
    const res = await runPlaywright(['--project=testscoped'], env, dir);
    expect(res.code, res.stdout + res.stderr).toBe(0);
    expect(res.report.stats.expected).toBe(6);
    const { events } = await admin.listRecentEvents(1000);
    const scratch = events.filter((e) => e.resourceId?.startsWith('scratch-'));
    expect(scratch.filter((e) => e.type === 'LEASE_ACQUIRED')).toHaveLength(6);
    expect(scratch.filter((e) => e.type === 'LEASE_RELEASED')).toHaveLength(6);
    const pool = await admin.getPool('scratch');
    expect(pool.counts).toMatchObject({ available: 2, leased: 0 });
    const evidence = evidenceAttachments(res.report);
    expect(evidence).toHaveLength(6);
    for (const { evidence: ev } of evidence) {
      expect(ev.leases[0]!.scope).toBe('test');
      expect(ev.leases[0]!.secretsResolved).toBe(false);
      expect(ev.leases[0]!.state).toBe('ACTIVE'); // evidence is captured before the release in teardown
    }
  }, 120_000);
});
