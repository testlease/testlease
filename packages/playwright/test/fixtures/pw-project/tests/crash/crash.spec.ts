import { writeFileSync } from 'node:fs';
import { test } from '../../fixtures.js';

test('worker dies mid-test without releasing', async ({ buyer }) => {
  // Tell the outer test which lease we hold, then die like a crashed CI worker would.
  writeFileSync(
    process.env.CRASH_LEASE_FILE!,
    JSON.stringify({ leaseId: buyer.leaseId, resourceId: buyer.resourceId }),
  );
  process.kill(process.pid, 'SIGKILL');
});
