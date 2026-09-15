import type { TestLeaseEngine } from '@testlease/core';

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/**
 * Minimal Prometheus text exposition: pool state gauges from the database plus in-process
 * counters since start. No histogram buckets, no dependencies; enough to alert on
 * "waiters piling up" or "timeouts climbing".
 */
export function renderMetrics(engine: TestLeaseEngine): string {
  const lines: string[] = [];
  const pools = engine.service.listPools();
  const counters = engine.service.metrics();

  lines.push(
    '# HELP testlease_pool_resources Resources per pool by state.',
    '# TYPE testlease_pool_resources gauge',
  );
  for (const p of pools) {
    for (const [state, n] of Object.entries(p.counts)) {
      if (state === 'total') continue;
      lines.push(
        `testlease_pool_resources{pool="${esc(p.name)}",state="${state.toUpperCase()}"} ${n}`,
      );
    }
  }
  lines.push(
    '# HELP testlease_pool_waiting Acquisitions currently waiting per pool.',
    '# TYPE testlease_pool_waiting gauge',
  );
  for (const p of pools) lines.push(`testlease_pool_waiting{pool="${esc(p.name)}"} ${p.waiting}`);

  const counterHelp: [keyof (typeof counters)[string], string, string][] = [
    ['acquired', 'testlease_acquisitions_total', 'Leases acquired (excluding idempotent reuse).'],
    [
      'reused',
      'testlease_acquire_reused_total',
      'Acquisitions answered with an existing lease (clientRequestId).',
    ],
    ['released', 'testlease_releases_total', 'Leases released by their owner or an administrator.'],
    ['expired', 'testlease_expirations_total', 'Leases reclaimed because their TTL elapsed.'],
    ['quarantined', 'testlease_quarantines_total', 'Resources quarantined through a lease.'],
    ['timeouts', 'testlease_acquire_timeouts_total', 'Acquisitions that waited and timed out.'],
    [
      'exhausted',
      'testlease_acquire_exhausted_total',
      'Acquisitions refused immediately (waitTimeoutMs = 0).',
    ],
  ];
  for (const [key, name, help] of counterHelp) {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
    for (const [pool, c] of Object.entries(counters))
      lines.push(`${name}{pool="${esc(pool)}"} ${c[key]}`);
  }
  lines.push(
    '# HELP testlease_acquire_wait_seconds Total time acquisitions waited before being served.',
    '# TYPE testlease_acquire_wait_seconds summary',
  );
  for (const [pool, c] of Object.entries(counters)) {
    lines.push(
      `testlease_acquire_wait_seconds_sum{pool="${esc(pool)}"} ${(c.waitMsSum / 1000).toFixed(3)}`,
    );
    lines.push(`testlease_acquire_wait_seconds_count{pool="${esc(pool)}"} ${c.waitCount}`);
  }
  lines.push('# HELP testlease_info Build information.', '# TYPE testlease_info gauge');
  lines.push(`testlease_info{schema_version="${engine.schemaVersion}"} 1`);
  return `${lines.join('\n')}\n`;
}
