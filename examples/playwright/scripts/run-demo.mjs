#!/usr/bin/env node
/**
 * Dogfooding demo runner:
 *   1. starts a TestLease server (testlease serve) with 3 premium-buyer accounts,
 *   2. runs the Playwright suite with 8 workers (24 tests),
 *   3. proves from the server's event log and from the tests' own usage log that no two
 *      workers ever used the same account at the same time, that waiting workers were served,
 *      and that every account was returned,
 *   4. prints where the sanitized testlease.json evidence ended up.
 *
 * Usage: node scripts/run-demo.mjs   (from examples/playwright, after `pnpm build`)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestLeaseClient } from '@testlease/client';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const bin = resolve(root, 'node_modules', 'testlease', 'bin', 'testlease.js');
const port = Number(process.env.DEMO_PORT ?? 4748);
const url = `http://127.0.0.1:${port}`;

const env = {
  ...process.env,
  BUYER_01_PASSWORD: process.env.BUYER_01_PASSWORD ?? 'demo-buyer-01-password',
  BUYER_02_PASSWORD: process.env.BUYER_02_PASSWORD ?? 'demo-buyer-02-password',
  BUYER_03_PASSWORD: process.env.BUYER_03_PASSWORD ?? 'demo-buyer-03-password',
  TESTLEASE_URL: url,
};

rmSync(join(root, 'test-results'), { recursive: true, force: true });
rmSync(join(root, '.testlease'), { recursive: true, force: true });
mkdirSync(join(root, '.testlease'), { recursive: true });

console.log(`▶ starting TestLease on ${url}`);
const server = spawn(
  process.execPath,
  [
    bin,
    'serve',
    '--config',
    'testlease.yml',
    '--port',
    String(port),
    '--log-level',
    'warn',
    '--no-pretty',
  ],
  {
    cwd: root,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  },
);
const client = new TestLeaseClient({ baseUrl: url, owner: 'demo-runner' });
for (let i = 0; i < 50; i++) {
  try {
    await client.health();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
const before = await client.getPool('premium-buyers');
console.log(
  `▶ pool premium-buyers: ${before.counts.total} accounts (${before.counts.available} available)`,
);

console.log('▶ running Playwright: 8 workers, 24 tests, 3 accounts');
const started = Date.now();
const pw = spawn(resolve(root, 'node_modules', '.bin', 'playwright'), ['test'], {
  cwd: root,
  env,
  stdio: 'inherit',
});
const pwCode = await new Promise((r) => pw.on('close', r));
const durationMs = Date.now() - started;

let ok = pwCode === 0;
const problems = [];

// --- proof 1: the tests' own usage log ------------------------------------------------------
const usagePath = join(root, 'test-results', 'usage.jsonl');
const usage = existsSync(usagePath)
  ? readFileSync(usagePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];
const byResource = new Map();
for (const u of usage) byResource.set(u.resourceId, [...(byResource.get(u.resourceId) ?? []), u]);
for (const [rid, list] of byResource) {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].leaseId !== sorted[i - 1].leaseId && sorted[i].start < sorted[i - 1].end) {
      problems.push(
        `usage overlap on ${rid}: worker ${sorted[i].worker} started before worker ${sorted[i - 1].worker} finished`,
      );
    }
  }
}

// --- proof 2: the server's event log --------------------------------------------------------
const { events } = await client.listRecentEvents(1000);
const active = new Map();
let acquisitions = 0;
let waited = 0;
let maxWaitMs = 0;
for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
  if (!e.resourceId?.startsWith('buyer-')) continue;
  if (e.type === 'LEASE_ACQUIRED') {
    if (active.has(e.resourceId)) problems.push(`double lease on ${e.resourceId} at seq ${e.seq}`);
    active.set(e.resourceId, e.leaseId);
    acquisitions++;
    const w = e.details?.waitedMs ?? 0;
    if (w > 0) waited++;
    maxWaitMs = Math.max(maxWaitMs, w);
  } else if (e.type === 'LEASE_RELEASED' || e.type === 'LEASE_EXPIRED') {
    if (active.get(e.resourceId) !== e.leaseId)
      problems.push(`${e.type} for unknown lease ${e.leaseId} on ${e.resourceId}`);
    active.delete(e.resourceId);
    if (e.type === 'LEASE_EXPIRED')
      problems.push(`lease ${e.leaseId} expired instead of being released`);
  }
}
const after = await client.getPool('premium-buyers');

console.log('\n════════ TestLease demo results ════════');
console.log(`Playwright exit code      ${pwCode}   (${(durationMs / 1000).toFixed(1)}s)`);
console.log(`tests that used an account ${usage.length}`);
console.log(`worker leases acquired     ${acquisitions}   (8 workers, 3 accounts)`);
console.log(
  `leases that had to wait    ${waited}   (longest wait ${(maxWaitMs / 1000).toFixed(1)}s)`,
);
console.log(`accounts used              ${[...byResource.keys()].sort().join(', ')}`);
console.log(
  `overlapping usage          ${problems.filter((p) => p.includes('overlap') || p.includes('double')).length}`,
);
console.log(`still leased after run     ${after.counts.leased}`);
console.log(`waiting after run          ${after.waiting}`);
console.log(
  `evidence per test          test-results/report.json → attachments "testlease.json" (also in playwright-report/)`,
);
if (problems.length) {
  ok = false;
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log(`  ✗ ${p}`);
} else if (after.counts.leased !== 0 || after.waiting !== 0 || acquisitions !== 8) {
  ok = false;
  console.log('\n✗ unexpected final state');
} else {
  console.log('\n✓ no collisions, all waiters served, all accounts returned');
}

server.kill('SIGTERM');
await new Promise((r) => server.on('exit', r));
process.exit(ok ? 0 : 1);
