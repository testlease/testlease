import type { Command } from 'commander';
import type { LeaseEvent, LeaseView, PoolDetail } from '@testlease/protocol';
import { formatDuration } from '@testlease/core';
import type { CliContext } from '../context.js';
import { EXIT } from '../output.js';

function stringify(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  return typeof v === 'object' ? JSON.stringify(v) : typeof v === 'string' ? v : JSON.stringify(v);
}

export function formatEvent(e: LeaseEvent, when: (ms: number) => string): string[] {
  const details = e.details
    ? Object.entries(e.details)
        .map(([k, v]) => `${k}=${stringify(v)}`)
        .join(' ')
    : '';
  return [
    String(e.seq),
    when(e.at),
    e.type,
    e.resourceId ?? '',
    e.leaseId ?? '',
    e.owner ?? '',
    details,
  ];
}

export function printLease(ctx: CliContext, lease: LeaseView): void {
  const { out } = ctx;
  out.line(
    `${out.paint('bold', lease.leaseId)}  ${out.state(lease.state)}${lease.endReason ? out.paint('dim', ` (${lease.endReason})`) : ''}`,
  );
  out.table(
    [
      ['pool', lease.pool],
      ['resource', lease.resourceId],
      ['owner', lease.owner],
      ['principal', lease.principal],
      ['created', `${out.when(lease.createdAt)}  (${out.relative(lease.createdAt)})`],
      ['expires', `${out.when(lease.expiresAt)}  (${out.relative(lease.expiresAt)})`],
      ['heartbeat', `${out.when(lease.lastHeartbeatAt)}  (${out.relative(lease.lastHeartbeatAt)})`],
      ['ttl', formatDuration(lease.ttlMs)],
      ...(lease.endedAt
        ? [['ended', `${out.when(lease.endedAt)}  (${out.relative(lease.endedAt)})`]]
        : []),
      ...(lease.purpose ? [['purpose', lease.purpose]] : []),
      ...(lease.clientRequestId ? [['requestId', lease.clientRequestId]] : []),
      [
        'tags',
        Object.entries(lease.resource.tags)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ') || '-',
      ],
      [
        'metadata',
        Object.entries(lease.resource.metadata)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(' ') || '-',
      ],
      ['secrets', lease.resource.secretKeys.join(', ') || '-'],
      ...(lease.context
        ? [
            [
              'context',
              Object.entries(lease.context)
                .map(([k, v]) => `${k}=${v}`)
                .join(' '),
            ],
          ]
        : []),
    ].map(([k, v]) => [out.paint('dim', k!), v!]),
    { indent: '  ' },
  );
}

function printPool(ctx: CliContext, pool: PoolDetail): void {
  const { out } = ctx;
  const now = Date.now();
  out.line(
    `${out.paint('bold', pool.name)}${pool.description ? out.paint('dim', `  ${pool.description}`) : ''}`,
  );
  out.line(
    `  defaultTtl=${formatDuration(pool.defaultTtlMs)}  maxTtl=${formatDuration(pool.maxTtlMs)}  available=${pool.counts.available}  leased=${pool.counts.leased}  quarantined=${pool.counts.quarantined}  disabled=${pool.counts.disabled}  waiting=${pool.waiting}`,
  );
  out.line();
  const rows: string[][] = [['RESOURCE', 'STATE', 'TAGS', 'OWNER', 'EXPIRES', 'NOTE']];
  for (const r of pool.resources) {
    const tags = Object.entries(r.tags)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    let owner = '';
    let expires = '';
    let note = '';
    if (r.activeLease) {
      owner = r.activeLease.owner;
      expires = out.relative(r.activeLease.expiresAt, now);
      if (r.activeLease.purpose) note = r.activeLease.purpose;
    }
    if (r.quarantine)
      note = `${r.quarantine.reason}${r.quarantine.by ? ` (by ${r.quarantine.by})` : ''}`;
    if (!r.enabledInConfig && r.state !== 'DISABLED')
      note = `${note ? `${note}; ` : ''}removed from config, disables when lease ends`;
    rows.push([r.id, out.state(r.state), tags, owner, expires, note]);
  }
  out.table(rows, { indent: '  ' });
  if (pool.waiters.length) {
    out.line();
    out.line(out.paint('bold', '  Waiting:'));
    out.table(
      [
        ['OWNER', 'TAGS', 'WAITING', 'PURPOSE'],
        ...pool.waiters.map((w) => [
          w.owner,
          Object.entries(w.tags)
            .map(([k, v]) => `${k}=${v}`)
            .join(','),
          formatDuration(w.waitingForMs),
          w.purpose ?? '',
        ]),
      ],
      { indent: '  ' },
    );
  }
}

export function registerReadCommands(program: Command, getCtx: () => CliContext): void {
  program
    .command('pools')
    .description('List pools')
    .action(async () => {
      const ctx = getCtx();
      const pools = await ctx.client().listPools();
      if (ctx.out.opts.json) return ctx.out.json({ pools });
      ctx.out.table([
        ['POOL', 'AVAILABLE', 'LEASED', 'QUARANTINED', 'DISABLED', 'TOTAL', 'WAITING', 'TTL'],
        ...pools.map((p) => [
          p.name,
          String(p.counts.available),
          String(p.counts.leased),
          String(p.counts.quarantined),
          String(p.counts.disabled),
          String(p.counts.total),
          String(p.waiting),
          formatDuration(p.defaultTtlMs),
        ]),
      ]);
    });

  program
    .command('status')
    .description('Show pool capacity at a glance')
    .action(async () => {
      const ctx = getCtx();
      const [health, pools] = await Promise.all([ctx.client().health(), ctx.client().listPools()]);
      if (ctx.out.opts.json) return ctx.out.json({ health, pools });
      ctx.out.line(
        `${ctx.out.paint('dim', ctx.url)}  ${health.status === 'ok' ? ctx.out.paint('green', 'ok') : ctx.out.paint('yellow', health.status)}  v${health.version}  auth=${health.auth.mode}  uptime=${formatDuration(health.uptimeMs)}`,
      );
      ctx.out.line();
      if (pools.length === 0) return ctx.out.line(ctx.out.paint('dim', 'No pools configured.'));
      ctx.out.table([
        ['POOL', 'AVAILABLE', 'LEASED', 'QUARANTINED', 'TOTAL', 'WAITING'],
        ...pools.map((p) => [
          p.name,
          String(p.counts.available),
          String(p.counts.leased),
          String(p.counts.quarantined),
          String(p.counts.total),
          p.waiting ? ctx.out.paint('yellow', String(p.waiting)) : '0',
        ]),
      ]);
    });

  program
    .command('inspect <pool>')
    .description('Show every resource in a pool with its state, owner and expiry')
    .action(async (pool: string) => {
      const ctx = getCtx();
      const detail = await ctx.client().getPool(pool);
      if (ctx.out.opts.json) return ctx.out.json(detail);
      printPool(ctx, detail);
    });

  program
    .command('lease <lease-id>')
    .description('Show a lease')
    .action(async (leaseId: string) => {
      const ctx = getCtx();
      const lease = await ctx.client().getLease(leaseId);
      if (ctx.out.opts.json) return ctx.out.json(lease);
      printLease(ctx, lease);
    });

  program
    .command('resource <resource-id>')
    .description('Show a resource (current configuration and state)')
    .action(async (resourceId: string) => {
      const ctx = getCtx();
      const r = await ctx.client().getResource(resourceId);
      if (ctx.out.opts.json) return ctx.out.json(r);
      ctx.out.line(
        `${ctx.out.paint('bold', r.id)}  ${ctx.out.state(r.state)}  pool=${r.pool}${r.enabledInConfig ? '' : ctx.out.paint('dim', '  (not in configuration)')}`,
      );
      ctx.out.table(
        [
          [
            'tags',
            Object.entries(r.tags)
              .map(([k, v]) => `${k}=${v}`)
              .join(' ') || '-',
          ],
          [
            'metadata',
            Object.entries(r.metadata)
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(' ') || '-',
          ],
          ['secrets', r.secretKeys.join(', ') || '-'],
          ...(r.activeLease
            ? [
                [
                  'lease',
                  `${r.activeLease.leaseId} owner=${r.activeLease.owner} expires ${ctx.out.relative(r.activeLease.expiresAt)}`,
                ],
              ]
            : []),
          ...(r.quarantine
            ? [
                [
                  'quarantine',
                  `${r.quarantine.reason} (${ctx.out.when(r.quarantine.at)}${r.quarantine.by ? `, by ${r.quarantine.by}` : ''})`,
                ],
              ]
            : []),
          ...(r.lastLeasedAt
            ? [
                [
                  'lastLeased',
                  `${ctx.out.when(r.lastLeasedAt)} (${ctx.out.relative(r.lastLeasedAt)})`,
                ],
              ]
            : []),
        ].map(([k, v]) => [ctx.out.paint('dim', k!), v!]),
        { indent: '  ' },
      );
    });

  program
    .command('events [lease-id]')
    .description(
      'Show the event history of a lease (default), a resource, or the most recent events',
    )
    .option('-r, --resource <resource-id>', 'events for a resource')
    .option('--recent [n]', 'most recent events server-wide')
    .action(
      async (
        leaseId: string | undefined,
        opts: { resource?: string; recent?: string | boolean },
      ) => {
        const ctx = getCtx();
        const client = ctx.client();
        let events: LeaseEvent[];
        if (opts.resource) events = (await client.listResourceEvents(opts.resource)).events;
        else if (opts.recent !== undefined)
          events = (
            await client.listRecentEvents(
              typeof opts.recent === 'string' ? Number(opts.recent) : 50,
            )
          ).events;
        else if (leaseId) events = (await client.listLeaseEvents(leaseId)).events;
        else {
          ctx.out.err('Provide a lease id, --resource <id>, or --recent.');
          process.exitCode = EXIT.USAGE;
          return;
        }
        if (ctx.out.opts.json) return ctx.out.json({ events });
        if (events.length === 0) return ctx.out.line(ctx.out.paint('dim', 'No events.'));
        ctx.out.table([
          ['SEQ', 'AT', 'EVENT', 'RESOURCE', 'LEASE', 'OWNER', 'DETAILS'],
          ...events.map((e) => formatEvent(e, (ms) => ctx.out.when(ms))),
        ]);
      },
    );

  program
    .command('leases')
    .description('List leases (default: active ones), newest first')
    .option('-s, --state <state>', 'ACTIVE | RELEASED | EXPIRED | ALL', 'ACTIVE')
    .option('-p, --pool <pool>', 'only this pool')
    .option('--owner <owner>', 'only this owner')
    .option('-n, --limit <n>', 'max rows (1-1000)', '100')
    .action(async (opts: { state: string; pool?: string; owner?: string; limit: string }) => {
      const ctx = getCtx();
      const { leases } = await ctx.client().listLeases({
        state: opts.state.toUpperCase() as 'ACTIVE' | 'RELEASED' | 'EXPIRED' | 'ALL',
        ...(opts.pool ? { pool: opts.pool } : {}),
        ...(opts.owner ? { owner: opts.owner } : {}),
        limit: Number(opts.limit),
      });
      if (ctx.out.opts.json) return ctx.out.json({ leases });
      if (leases.length === 0) return ctx.out.line(ctx.out.paint('dim', 'No leases.'));
      const now = Date.now();
      ctx.out.table([
        [
          'LEASE',
          'STATE',
          'POOL',
          'RESOURCE',
          'OWNER',
          'PRINCIPAL',
          'AGE',
          'EXPIRES/ENDED',
          'RENEWS',
        ],
        ...leases.map((l) => [
          l.leaseId,
          ctx.out.state(l.state),
          l.pool,
          l.resourceId,
          l.owner,
          l.principal,
          formatDuration(now - l.createdAt),
          l.state === 'ACTIVE'
            ? ctx.out.relative(l.expiresAt, now)
            : `${l.endReason ?? ''} ${l.endedAt ? ctx.out.relative(l.endedAt, now) : ''}`.trim(),
          String(l.renewCount),
        ]),
      ]);
    });

  program
    .command('whoami')
    .description('Show how the server sees this client (auth mode, principal, scopes)')
    .action(async () => {
      const ctx = getCtx();
      const who = await ctx.client().whoami();
      if (ctx.out.opts.json) return ctx.out.json({ ...who, owner: ctx.owner });
      ctx.out.line(`principal=${who.principal}  auth=${who.auth}  owner=${ctx.owner}`);
      ctx.out.line(`scopes: ${who.scopes.join(', ')}`);
      ctx.out.line(`pools: ${who.pools ? who.pools.join(', ') : '(all)'}`);
    });
}
