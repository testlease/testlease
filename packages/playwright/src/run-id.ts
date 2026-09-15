import { hostname } from 'node:os';

/**
 * Derives a stable run identifier from well-known CI variables so that every worker of one
 * test run shares the same owner prefix. Call `ensureRunId()` from playwright.config.ts so the
 * value is fixed once in the runner process and inherited by all workers.
 */
export function detectRunId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.TESTLEASE_RUN_ID) return env.TESTLEASE_RUN_ID;
  if (env.GITHUB_RUN_ID)
    return `gha-${env.GITHUB_RUN_ID}${env.GITHUB_RUN_ATTEMPT ? `-${env.GITHUB_RUN_ATTEMPT}` : ''}`;
  if (env.CI_PIPELINE_ID)
    return `gitlab-${env.CI_PIPELINE_ID}${env.CI_JOB_ID ? `-${env.CI_JOB_ID}` : ''}`;
  if (env.CIRCLE_WORKFLOW_ID) return `circle-${env.CIRCLE_WORKFLOW_ID}`;
  if (env.BUILDKITE_BUILD_ID) return `buildkite-${env.BUILDKITE_BUILD_ID}`;
  if (env.BUILD_BUILDID) return `azdo-${env.BUILD_BUILDID}`;
  if (env.BUILD_ID) return `ci-${env.BUILD_ID}`;
  return undefined;
}

export function ensureRunId(env: NodeJS.ProcessEnv = process.env): string {
  const detected = detectRunId(env);
  if (detected) {
    env.TESTLEASE_RUN_ID = detected;
    return detected;
  }
  const local = `local-${hostname()}-${Date.now().toString(36)}`;
  env.TESTLEASE_RUN_ID = local;
  return local;
}

/** Sanitises a value for use inside an owner string (no whitespace or control characters). */
export function ownerSegment(value: string): string {
  return value.replace(/[\s/]+|\p{Cc}+/gu, '-').slice(0, 60) || 'x';
}
