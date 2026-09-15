import type { TestInfo, TestType, WorkerInfo } from '@playwright/test';
import { Lease, TestLeaseClient, type TestLeaseClientOptions } from '@testlease/client';
import { isTestLeaseError, type TestLeaseError } from '@testlease/protocol';
import {
  LeasedResource,
  type FixtureEvidence,
  type LeaseFixtureConfig,
  type LeaseScope,
  type ResolveResult,
} from './leased-resource.js';
import { detectRunId, ownerSegment } from './run-id.js';

export interface EvidenceOptions {
  /** Attachment name (default `testlease.json`). */
  attachmentName?: string;
  /** Re-fetch each lease from the server after the test to detect expiry (default true). */
  refresh?: boolean;
}

/**
 * `F` is constrained homomorphically (`{ [K in keyof F]: LeaseFixtureConfig }`) instead of
 * `Record<string, LeaseFixtureConfig>`: with an index-signature constraint TypeScript widens a
 * fixtures literal containing expressions such as `cond ? { region } : {}` to an index signature,
 * which made every fixture `LeasedResource | undefined` under noUncheckedIndexedAccess.
 */
export interface WithTestLeaseOptions<F extends { [K in keyof F]: LeaseFixtureConfig }> {
  /** Client options, or a factory (called once per worker). */
  client: TestLeaseClientOptions | (() => TestLeaseClient);
  fixtures: F;
  /** Overrides run id detection (TESTLEASE_RUN_ID / CI variables). */
  runId?: string;
  /** Default wait for every fixture (default 60s). */
  waitTimeoutMs?: number;
  /** Automatic heartbeat (default true). */
  heartbeat?: boolean;
  /** Attach sanitized lease evidence to every test (default true). */
  evidence?: boolean | EvidenceOptions;
}

type WorkerKeys<F> = { [K in keyof F]: F[K] extends { scope: 'test' } ? never : K }[keyof F];
type TestKeys<F> = { [K in keyof F]: F[K] extends { scope: 'test' } ? K : never }[keyof F];

export type TestLeaseWorkerFixtures<F> = { [K in WorkerKeys<F>]: LeasedResource } & {
  /** The per-worker TestLease client (for assertions about pool state). */
  testleaseClient: TestLeaseClient;
};
export type TestLeaseTestFixtures<F> = { [K in TestKeys<F>]: LeasedResource } & {
  /** Auto fixture: re-acquires ended worker leases before a test and attaches evidence after it. */
  testleaseEvidence: void;
};

const DEFAULT_WAIT_MS = 60_000;

interface WorkerState {
  runId: string;
  project: string;
  workerOwner: string;
  resources: Map<string, LeasedResource>; // by fixture name
}

/** Module state is per worker process in Playwright, so this is naturally worker-local. */
const workerStates = new WeakMap<TestLeaseClient, WorkerState>();

function projectName(info: WorkerInfo | TestInfo): string {
  return ownerSegment(info.project.name || 'default');
}

function fixtureErrorMessage(name: string, cfg: LeaseFixtureConfig, err: unknown): string {
  if (isTestLeaseError(err)) {
    const e = err as TestLeaseError;
    let hint = '';
    if (e.code === 'ACQUIRE_TIMEOUT')
      hint = ' Increase waitTimeoutMs, add resources to the pool, or reduce Playwright workers.';
    if (e.code === 'FORBIDDEN' && e.details?.requiredScope === 'secrets:resolve') {
      hint = ` The API token lacks secrets:resolve. Grant it, or set secrets: false on the "${name}" fixture if the tests do not need credentials.`;
    }
    if (e.code === 'UNAVAILABLE') hint = ' Is the TestLease server running? Check TESTLEASE_URL.';
    return `TestLease fixture "${name}" (pool "${cfg.pool}") failed: [${e.code}] ${e.message}${hint}`;
  }
  return `TestLease fixture "${name}" (pool "${cfg.pool}") failed: ${(err as Error).message}`;
}

/**
 * Wraps a Playwright `test` object with lease fixtures. Every configured fixture becomes an
 * exclusive resource: worker-scoped ones are held for the worker's lifetime, test-scoped ones
 * per test. Acquire, heartbeat, release and evidence are automatic.
 */
export function withTestLease<
  T extends object,
  W extends object,
  F extends { [K in keyof F]: LeaseFixtureConfig },
>(
  base: TestType<T, W>,
  options: WithTestLeaseOptions<F>,
): TestType<T & TestLeaseTestFixtures<F>, W & TestLeaseWorkerFixtures<F>> {
  return base.extend<TestLeaseTestFixtures<F>, TestLeaseWorkerFixtures<F>>(
    createTestLeaseFixtures(options) as never,
  ) as unknown as TestType<T & TestLeaseTestFixtures<F>, W & TestLeaseWorkerFixtures<F>>;
}

/**
 * Builds the fixture definitions for `test.extend(...)`. Use this directly when you already
 * have your own `extend` chain.
 */
export function createTestLeaseFixtures<F extends { [K in keyof F]: LeaseFixtureConfig }>(
  options: WithTestLeaseOptions<F>,
): Record<string, unknown> {
  const evidenceOpts: EvidenceOptions | null =
    options.evidence === false
      ? null
      : typeof options.evidence === 'object'
        ? options.evidence
        : {};
  const heartbeat = options.heartbeat !== false;

  const makeClient = (): TestLeaseClient =>
    typeof options.client === 'function' ? options.client() : new TestLeaseClient(options.client);

  async function acquireFor(
    client: TestLeaseClient,
    name: string,
    cfg: LeaseFixtureConfig,
    owner: string,
    context: Record<string, string>,
    purpose: string,
  ): Promise<{ result: ResolveResult; secrets: Record<string, string>; secretsResolved: boolean }> {
    let lease: Lease;
    let reused: boolean;
    let waitedMs: number;
    try {
      const raw = await client.acquire({
        pool: cfg.pool,
        owner,
        tags: cfg.tags ?? {},
        ...(cfg.ttlMs ? { ttlMs: cfg.ttlMs } : {}),
        waitTimeoutMs: cfg.waitTimeoutMs ?? options.waitTimeoutMs ?? DEFAULT_WAIT_MS,
        clientRequestId: `${owner}#${name}`,
        purpose,
        context,
      });
      reused = raw.reused;
      waitedMs = raw.waitedMs;
      lease = new Lease(client, raw.lease);
      if (heartbeat) lease.startHeartbeat();
    } catch (err) {
      throw new Error(fixtureErrorMessage(name, cfg, err), { cause: err });
    }
    let secrets: Record<string, string> = {};
    let secretsResolved = true;
    if (cfg.secrets !== false && lease.resource.secretKeys.length > 0) {
      try {
        secrets = await lease.secrets();
      } catch (err) {
        await lease.release().catch(() => undefined);
        throw new Error(fixtureErrorMessage(name, cfg, err), { cause: err });
      }
    } else if (cfg.secrets === false) {
      secretsResolved = false;
    }
    return { result: { lease, reused, waitedMs }, secrets, secretsResolved };
  }

  const fixtureConfigs = options.fixtures as unknown as Record<string, LeaseFixtureConfig>;
  const fixtures: Record<string, unknown> = {};

  fixtures.testleaseClient = [
    // Playwright parses fixture functions and requires the first parameter to be an object
    // destructuring pattern, even when no other fixtures are needed.
    // eslint-disable-next-line no-empty-pattern
    async ({}: object, use: (c: TestLeaseClient) => Promise<void>, workerInfo: WorkerInfo) => {
      const client = makeClient();
      const runId = options.runId ?? detectRunId() ?? `local-${Date.now().toString(36)}`;
      const project = projectName(workerInfo);
      workerStates.set(client, {
        runId,
        project,
        workerOwner: `${ownerSegment(runId)}/${project}/worker-${workerInfo.parallelIndex}`,
        resources: new Map(),
      });
      await use(client);
    },
    { scope: 'worker' as const },
  ];

  for (const [name, cfg] of Object.entries(fixtureConfigs)) {
    const scope: LeaseScope = cfg.scope ?? 'worker';
    if (scope === 'worker') {
      fixtures[name] = [
        async (
          { testleaseClient }: { testleaseClient: TestLeaseClient },
          use: (r: LeasedResource) => Promise<void>,
          workerInfo: WorkerInfo,
        ) => {
          const state = workerStates.get(testleaseClient)!;
          const owner = state.workerOwner;
          const ownerParts = {
            runId: state.runId,
            project: state.project,
            worker: `worker-${workerInfo.parallelIndex}`,
          };
          const context = {
            runId: state.runId,
            project: state.project,
            parallelIndex: String(workerInfo.parallelIndex),
            workerIndex: String(workerInfo.workerIndex),
            fixture: name,
          };
          const { result, secrets, secretsResolved } = await acquireFor(
            testleaseClient,
            name,
            cfg,
            owner,
            context,
            cfg.purpose ?? `${state.project} worker-${workerInfo.parallelIndex}: ${name}`,
          );
          const resource = new LeasedResource({
            fixture: name,
            scope,
            ownerParts,
            client: testleaseClient,
            lease: result.lease,
            secrets,
            secretsResolved,
            reused: result.reused,
            waitedMs: result.waitedMs,
          });
          state.resources.set(name, resource);
          try {
            await use(resource);
          } finally {
            state.resources.delete(name);
            await resource.release().catch(() => undefined);
          }
        },
        { scope: 'worker' as const },
      ];
    } else {
      fixtures[name] = [
        async (
          { testleaseClient }: { testleaseClient: TestLeaseClient },
          use: (r: LeasedResource) => Promise<void>,
          testInfo: TestInfo,
        ) => {
          const state = workerStates.get(testleaseClient)!;
          const owner = `${state.workerOwner}/test-${testInfo.testId}`;
          const ownerParts = {
            runId: state.runId,
            project: state.project,
            worker: `worker-${testInfo.parallelIndex}`,
            test: testInfo.testId,
          };
          const context = {
            runId: state.runId,
            project: state.project,
            parallelIndex: String(testInfo.parallelIndex),
            testId: testInfo.testId,
            title: testInfo.title.slice(0, 200),
            fixture: name,
          };
          const { result, secrets, secretsResolved } = await acquireFor(
            testleaseClient,
            name,
            cfg,
            owner,
            context,
            cfg.purpose ?? `${testInfo.title}`.slice(0, 200),
          );
          const resource = new LeasedResource({
            fixture: name,
            scope,
            ownerParts,
            client: testleaseClient,
            lease: result.lease,
            secrets,
            secretsResolved,
            reused: result.reused,
            waitedMs: result.waitedMs,
          });
          state.resources.set(`${name}@${testInfo.testId}`, resource);
          try {
            await use(resource);
          } finally {
            if (evidenceOpts) await attachEvidence(testInfo, [resource], evidenceOpts, [secrets]);
            state.resources.delete(`${name}@${testInfo.testId}`);
            await resource.release().catch(() => undefined);
          }
        },
        { scope: 'test' as const },
      ];
    }
  }

  fixtures.testleaseEvidence = [
    async (
      { testleaseClient }: { testleaseClient: TestLeaseClient },
      use: () => Promise<void>,
      testInfo: TestInfo,
    ) => {
      const state = workerStates.get(testleaseClient)!;
      // Before the test: a worker lease that ended (quarantine, expiry) is replaced so the test
      // does not run against a dead resource.
      for (const [name, resource] of state.resources) {
        if (resource.scope !== 'worker' || !resource.ended) continue;
        const cfg = fixtureConfigs[name]!;
        const { result, secrets, secretsResolved } = await acquireFor(
          testleaseClient,
          name,
          cfg,
          state.workerOwner,
          {
            runId: state.runId,
            project: state.project,
            parallelIndex: String(testInfo.parallelIndex),
            fixture: name,
            reacquired: 'true',
          },
          cfg.purpose ?? `${state.project} worker-${testInfo.parallelIndex}: ${name} (replacement)`,
        );
        resource.replace(result, secrets, secretsResolved);
      }
      await use();
      if (evidenceOpts) {
        const workerResources = [...state.resources.values()].filter((r) => r.scope === 'worker');
        if (workerResources.length)
          await attachEvidence(
            testInfo,
            workerResources,
            evidenceOpts,
            workerResources.map((r) => r.secrets),
          );
      }
    },
    { scope: 'test' as const, auto: true },
  ];

  return fixtures;
}

async function attachEvidence(
  testInfo: TestInfo,
  resources: LeasedResource[],
  opts: EvidenceOptions,
  secretSets: Record<string, string>[],
): Promise<void> {
  const leases: FixtureEvidence[] = [];
  for (const r of resources) leases.push(await r.collectEvidence(opts.refresh !== false));
  const body = {
    generatedAt: new Date().toISOString(),
    test: {
      title: testInfo.title,
      file: testInfo.file,
      status: testInfo.status,
      expectedStatus: testInfo.expectedStatus,
      retry: testInfo.retry,
      duration: testInfo.duration,
    },
    worker: {
      parallelIndex: testInfo.parallelIndex,
      workerIndex: testInfo.workerIndex,
      project: testInfo.project.name,
    },
    leases,
  };
  let json = JSON.stringify(body, null, 2);
  // Defense in depth: evidence must never contain a secret value, whatever the shape above.
  for (const secrets of secretSets) {
    for (const [key, value] of Object.entries(secrets)) {
      if (value.length >= 4 && json.includes(value))
        json = json.split(value).join(`[REDACTED:${key}]`);
    }
  }
  const name = opts.attachmentName ?? 'testlease.json';
  const existing = testInfo.attachments.find((a) => a.name === name);
  if (existing) return; // test-scoped fixture already attached in this test
  await testInfo.attach(name, { body: json, contentType: 'application/json' });
}
