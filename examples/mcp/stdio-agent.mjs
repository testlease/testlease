/**
 * An "agent" that coordinates a test resource through MCP over stdio.
 * It spawns `testlease mcp` (the bridge to a running TestLease server) exactly like an agent
 * host would, then: pool status -> acquire -> (pretend to run tests) -> release.
 *
 *   testlease serve --config ../playwright/testlease.yml      # terminal 1 (with BUYER_0x_PASSWORD set)
 *   node stdio-agent.mjs                                      # terminal 2
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bin = require.resolve('testlease/bin/testlease.js');
const url = process.env.TESTLEASE_URL ?? 'http://127.0.0.1:4747';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bin, 'mcp', '--url', url],
  env: { ...process.env, TESTLEASE_OWNER: 'mcp:example-stdio-agent' },
  stderr: 'inherit',
});
const client = new Client({ name: 'example-stdio-agent', version: '0.1.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log(
  'tools:',
  tools.tools
    .map((t) => `${t.name}${t.annotations?.readOnlyHint ? ' (read-only)' : ''}`)
    .join(', '),
);

const status = await client.callTool({
  name: 'testlease_pool_status',
  arguments: { pool: 'premium-buyers' },
});
console.log('\n' + status.content[0].text);

const acquired = await client.callTool({
  name: 'testlease_acquire',
  arguments: {
    pool: 'premium-buyers',
    tags: { region: 'nl' },
    ttlSeconds: 300,
    waitSeconds: 30,
    purpose: 'run checkout accessibility tests',
    clientRequestId: 'example-stdio-agent-1',
  },
});
if (acquired.isError) {
  console.error('\nacquire failed:\n' + acquired.content[0].text);
  await client.close();
  process.exit(1);
}
const lease = acquired.structuredContent;
console.log('\nacquired:', JSON.stringify(lease, null, 2));
console.log(
  '\nNote: the agent sees availableSecretKeys =',
  lease.availableSecretKeys,
  'but never the values.',
);
console.log(
  'A test runner would now use `testlease exec --lease',
  lease.leaseId,
  '-- npm test` with a secrets:resolve token.',
);

await new Promise((r) => setTimeout(r, 1000)); // pretend the tests ran

const released = await client.callTool({
  name: 'testlease_release',
  arguments: { leaseId: lease.leaseId },
});
console.log('\n' + released.content[0].text);
await client.close();
