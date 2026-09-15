export {
  TestLeaseClient,
  defaultOwner,
  CLIENT_VERSION,
  type TestLeaseClientOptions,
  type AcquireLeaseOptions,
} from './client.js';
export {
  Lease,
  requireSecret,
  type HeartbeatOptions,
  type HeartbeatStatus,
  type LeaseEvidence,
} from './lease.js';
export { HttpTransport, type HttpOptions, type RequestOptions } from './http.js';
export * from '@testlease/protocol';
