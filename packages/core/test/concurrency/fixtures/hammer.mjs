// Child process used by multiprocess.test.ts. Uses the *built* core (dist) against a shared
// SQLite file to prove cross-process atomicity of acquisition. Each iteration tries to acquire
// without waiting; on success it holds the lease briefly, verifies it is still the owner, and
// releases. Prints a JSON summary on exit.
import { openDatabase, migrate, SqliteStore, LeaseService } from '../../../dist/index.js';

const [dbPath, processName, iterationsArg] = process.argv.slice(2);
const iterations = Number(iterationsArg ?? 200);
const db = openDatabase(dbPath);
migrate(db);
const store = new SqliteStore(db);
const service = new LeaseService({ store });

let acquired = 0;
let denied = 0;
let errors = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < iterations; i++) {
  try {
    const res = service.tryAcquire({ pool: 'accounts', owner: `${processName}` , clientRequestId: `${processName}-${i}` });
    if (!res) {
      denied++;
      await sleep(Math.random() * 2);
      continue;
    }
    acquired++;
    await sleep(Math.random() * 3);
    const check = store.getResource(res.lease.resourceId);
    if (check.activeLeaseId !== res.lease.leaseId) {
      console.error(`OWNERSHIP LOST: ${processName} lease ${res.lease.leaseId} on ${res.lease.resourceId}, active is ${check.activeLeaseId}`);
      process.exitCode = 3;
    }
    const rel = service.release(res.lease.leaseId, { owner: processName });
    if (rel.outcome !== 'released') {
      console.error(`UNEXPECTED RELEASE OUTCOME ${rel.outcome}`);
      process.exitCode = 3;
    }
  } catch (err) {
    errors++;
    console.error(`${processName} error: ${err.message}`);
  }
}
db.close();
console.log(JSON.stringify({ processName, acquired, denied, errors }));
