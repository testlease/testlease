/**
 * Framework-agnostic usage of the TypeScript client. Run against a local server:
 *
 *   testlease serve --config ../playwright/testlease.yml     # in another terminal
 *   node --experimental-strip-types acquire-and-release.ts
 */
import { TestLeaseClient, isTestLeaseError } from '@testlease/client';

const client = new TestLeaseClient({
  baseUrl: process.env.TESTLEASE_URL ?? 'http://127.0.0.1:4747',
  token: process.env.TESTLEASE_TOKEN,
  owner: `vanilla-example/${process.pid}`,
});

try {
  const lease = await client.acquireLease({
    pool: 'premium-buyers',
    tags: { region: 'nl' },
    waitTimeoutMs: 30_000,
    purpose: 'vanilla example',
  });
  console.log(
    `acquired ${lease.resourceId} as ${lease.owner}; expires ${new Date(lease.expiresAt).toISOString()}`,
  );
  console.log(
    `email: ${String(lease.metadata.email)}; secrets available: ${lease.resource.secretKeys.join(', ')}`,
  );

  // The heartbeat is already running; do the work.
  await new Promise((r) => setTimeout(r, 1500));

  // Decide what to do with the resource when finished.
  if (process.env.CONTAMINATED === '1') {
    await lease.quarantine('example: account state is unusable');
    console.log(
      `quarantined ${lease.resourceId}; restore with: testlease restore ${lease.resourceId}`,
    );
  } else {
    const { outcome } = await lease.release();
    console.log(`released (${outcome})`);
  }
  console.log(JSON.stringify(lease.evidence(), null, 2));
} catch (err) {
  if (isTestLeaseError(err)) {
    console.error(`${err.code}: ${err.message}`);
    process.exitCode = err.code === 'ACQUIRE_TIMEOUT' || err.code === 'POOL_EXHAUSTED' ? 3 : 1;
  } else {
    throw err;
  }
}
