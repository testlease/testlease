export {
  withTestLease,
  createTestLeaseFixtures,
  type WithTestLeaseOptions,
  type EvidenceOptions,
  type TestLeaseWorkerFixtures,
  type TestLeaseTestFixtures,
} from './with-test-lease.js';
export {
  LeasedResource,
  type LeaseFixtureConfig,
  type LeaseScope,
  type FixtureEvidence,
} from './leased-resource.js';
export { ensureRunId, detectRunId, ownerSegment } from './run-id.js';
export type {
  Lease,
  LeaseEvidence,
  TestLeaseClient,
  TestLeaseClientOptions,
} from '@testlease/client';
