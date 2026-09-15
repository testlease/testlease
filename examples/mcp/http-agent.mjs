/**
 * The same agent workflow over Streamable HTTP against the /mcp endpoint of a running
 * TestLease server. When the server uses tokens, pass one via TESTLEASE_TOKEN; the lease owner
 * becomes `mcp:<token name>:<session>`.
 *
 *   testlease serve --config ../playwright/testlease.yml
 *   TESTLEASE_URL=http://127.0.0.1:4747 node http-agent.mjs
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = process.env.TESTLEASE_URL ?? 'http://127.0.0.1:4747';
const token = process.env.TESTLEASE_TOKEN;

const transport = new StreamableHTTPClientTransport(
  new URL(`${url}/mcp`),
  token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {},
);
const client = new Client({ name: 'example-http-agent', version: '0.1.0' });
await client.connect(transport);
console.log('session:', transport.sessionId);

const pools = await client.callTool({ name: 'testlease_list_pools', arguments: {} });
console.log(pools.content[0].text);

const resource = await client.readResource({ uri: 'testlease://pools/premium-buyers' });
console.log('\nresource testlease://pools/premium-buyers:\n' + resource.contents[0].text);

const acquired = await client.callTool({
  name: 'testlease_acquire',
  arguments: { pool: 'premium-buyers', waitSeconds: 10, purpose: 'http example' },
});
if (acquired.isError) {
  console.error(acquired.content[0].text);
} else {
  const lease = acquired.structuredContent;
  console.log('\nacquired', lease.resourceId, 'as', lease.leaseId, 'owner', lease.owner);
  const events = await client.callTool({
    name: 'testlease_lease_events',
    arguments: { leaseId: lease.leaseId },
  });
  console.log(events.content[0].text);
  const released = await client.callTool({
    name: 'testlease_release',
    arguments: { leaseId: lease.leaseId },
  });
  console.log(released.content[0].text);
}
await transport.terminateSession();
await client.close();
