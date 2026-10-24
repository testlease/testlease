#!/usr/bin/env node
/**
 * Agent hand-off demo:
 *   1. starts a TestLease server with one rate-limited API key and three tokens: two agents
 *      without secrets:resolve, and a runner that may act for them (delegateFor),
 *   2. runs two agents concurrently; each acquires the key over MCP (stdio bridge), so the
 *      second one waits for the first,
 *   3. for each lease, the runner runs `testlease exec --lease <id>` with its own token: it
 *      resolves the key on the agent's behalf, heartbeats, and releases when the command exits,
 *   4. proves from the server's event log that the key never had two holders, that every
 *      delegated call recorded `onBehalfOf`, that agent tokens cannot resolve secrets, and that no
 *      MCP response or event contains the key.
 *
 * Usage: node scripts/run-demo.mjs   (from examples/agents, after `pnpm build`)
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { TestLeaseClient } from '@testlease/client';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const bin = resolve(root, 'node_modules', 'testlease', 'bin', 'testlease.js');
const port = Number(process.env.DEMO_PORT ?? 4749);
const url = `http://127.0.0.1:${port}`;

const tokens = {
  'agent-a': 'demo-agent-a-token-0001',
  'agent-b': 'demo-agent-b-token-0002',
  runner: 'demo-runner-token-0003',
};
const apiKey = process.env.LLM_KEY_01 ?? 'demo-llm-key-01-value';
const env = {
  ...process.env,
  TESTLEASE_TOKEN_AGENT_A: tokens['agent-a'],
  TESTLEASE_TOKEN_AGENT_B: tokens['agent-b'],
  TESTLEASE_TOKEN_RUNNER: tokens.runner,
  LLM_KEY_01: apiKey,
};

rmSync(join(root, '.testlease'), { recursive: true, force: true });
mkdirSync(join(root, '.testlease'), { recursive: true });

console.log(`▶ starting TestLease on ${url}`);
const server = spawn(
  process.execPath,
  [bin, 'serve', '--config', 'testlease.yml', '--port', String(port), '--log-level', 'warn'],
  { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] },
);
const runner = new TestLeaseClient({ baseUrl: url, token: tokens.runner, owner: 'demo-runner' });
for (let i = 0; i < 50; i++) {
  try {
    await runner.health();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

const problems = [];
const mcpTexts = [];

async function runAgent(name, task) {
  const owner = `agent:${name}/${task}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, 'mcp', '--url', url],
    env: { ...process.env, TESTLEASE_TOKEN: tokens[name], TESTLEASE_OWNER: owner },
    stderr: 'inherit',
  });
  const mcp = new Client({ name: `example-${name}`, version: '0.1.0' });
  await mcp.connect(transport);
  const call = async (tool, args) => {
    const res = await mcp.callTool({ name: tool, arguments: args });
    mcpTexts.push(JSON.stringify(res));
    return res;
  };

  try {
    const acquired = await call('testlease_acquire', {
      pool: 'api-keys',
      ttlSeconds: 60,
      waitSeconds: 60,
      purpose: task,
      clientRequestId: `${name}-${task}`,
    });
    if (acquired.isError) {
      problems.push(`${name} could not acquire: ${acquired.content[0].text}`);
      return;
    }
    const lease = acquired.structuredContent;
    console.log(
      `▶ ${name} acquired ${lease.resourceId} (${lease.leaseId}) after ${lease.waitedSeconds}s; it sees secret keys ${JSON.stringify(lease.availableSecretKeys)}`,
    );

    // The agent's own token has no secrets:resolve scope: resolving must be refused.
    const asAgent = new TestLeaseClient({ baseUrl: url, token: tokens[name], owner });
    try {
      await asAgent.resolveSecrets(lease.leaseId, { owner });
      problems.push(`${name} resolved secrets with its own token`);
    } catch (err) {
      if (err.code !== 'FORBIDDEN') problems.push(`${name}: expected FORBIDDEN, got ${err.code}`);
    }

    // Hand-off: the runner uses the agent's lease with its own token.
    const exec = spawn(
      process.execPath,
      [bin, 'exec', '--url', url, '--lease', lease.leaseId, '--', process.execPath, 'use-key.mjs'],
      { cwd: root, env: { ...process.env, TESTLEASE_TOKEN: tokens.runner }, stdio: 'inherit' },
    );
    const code = await new Promise((r) => exec.on('close', r));
    if (code !== 0) problems.push(`runner exec for ${name} exited with ${code}`);

    // exec already released the lease; releasing again is idempotent.
    const released = await call('testlease_release', { leaseId: lease.leaseId });
    console.log(`▶ ${name}: ${released.content[0].text}`);
    await call('testlease_lease_events', { leaseId: lease.leaseId });
  } finally {
    await mcp.close();
  }
}

await Promise.all([runAgent('agent-a', 'summarize-issues'), runAgent('agent-b', 'triage-logs')]);

// --- proof: the server's event log ----------------------------------------------------------
const { events } = await runner.listRecentEvents(1000);
let holder = null;
let acquisitions = 0;
let waited = 0;
let delegated = 0;
for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
  if (e.pool !== 'api-keys') continue;
  if (e.type === 'LEASE_ACQUIRED') {
    if (holder) problems.push(`double lease on ${e.resourceId} at seq ${e.seq}`);
    holder = e.leaseId;
    acquisitions++;
    if ((e.details?.waitedMs ?? 0) > 0) waited++;
  } else if (e.type === 'LEASE_RELEASED' || e.type === 'LEASE_EXPIRED') {
    if (e.type === 'LEASE_EXPIRED') problems.push(`lease ${e.leaseId} expired instead of released`);
    holder = null;
  }
  if (e.type === 'LEASE_SECRETS_RESOLVED' || e.type === 'LEASE_RELEASED') {
    const agent = e.details?.onBehalfOf;
    if (agent !== 'agent-a' && agent !== 'agent-b')
      problems.push(`${e.type} for ${e.leaseId} has no onBehalfOf agent`);
    else delegated++;
  }
}
if (JSON.stringify(events).includes(apiKey)) problems.push('an event contains the API key');
if (mcpTexts.some((t) => t.includes(apiKey))) problems.push('an MCP response contains the API key');
const after = await runner.getPool('api-keys');

console.log('\n════════ TestLease agent demo results ════════');
console.log(`leases acquired over MCP       ${acquisitions}   (2 agents, 1 key)`);
console.log(`leases that had to wait        ${waited}`);
console.log(`delegated events (onBehalfOf)  ${delegated}`);
console.log(`still leased after run         ${after.counts.leased}`);
const ok = problems.length === 0 && acquisitions === 2 && waited === 1 && after.counts.leased === 0;
if (problems.length) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log(`  ✗ ${p}`);
} else if (!ok) {
  console.log('\n✗ unexpected final state');
} else {
  console.log('\n✓ one holder at a time, agents never saw the key, every hand-off is on record');
}

server.kill('SIGTERM');
await new Promise((r) => server.on('exit', r));
process.exit(ok ? 0 : 1);
