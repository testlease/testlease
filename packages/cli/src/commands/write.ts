import type { Command } from 'commander';
import type { TestLeaseError } from '@testlease/protocol';
import { parseDuration } from '@testlease/core';
import type { CliContext } from '../context.js';
import { parseKeyValues, reportError } from '../output.js';
import { printLease } from './read.js';

export const OWNERSHIP_HINTS = [
  'Use --owner <owner> to act as the lease owner (the token/principal must match too),',
  'or --force to release as an administrator (requires the lease:admin scope).',
];

export function registerWriteCommands(program: Command, getCtx: () => CliContext): void {
  program
    .command('acquire <pool>')
    .description('Acquire a lease and print it. Use --wait to queue for a busy pool.')
    .option('-t, --tag <key=value...>', 'required tags (repeatable)')
    .option('--ttl <duration>', 'lease TTL, e.g. 10m (default: pool default)')
    .option(
      '-w, --wait <duration>',
      'how long to wait for a free resource (default: 0 = fail fast)',
    )
    .option('-p, --purpose <text>', 'why this lease exists (shown in diagnostics)')
    .option(
      '--request-id <id>',
      'idempotency key (a retry with the same id returns the same lease)',
    )
    .action(
      async (
        pool: string,
        opts: { tag?: string[]; ttl?: string; wait?: string; purpose?: string; requestId?: string },
      ) => {
        const ctx = getCtx();
        const res = await ctx.client().acquire({
          pool,
          owner: ctx.owner,
          tags: parseKeyValues(opts.tag, 'tag'),
          ...(opts.ttl ? { ttlMs: parseDuration(opts.ttl) } : {}),
          ...(opts.wait ? { waitTimeoutMs: parseDuration(opts.wait) } : {}),
          ...(opts.purpose ? { purpose: opts.purpose } : {}),
          ...(opts.requestId ? { clientRequestId: opts.requestId } : {}),
        });
        if (ctx.out.opts.json) return ctx.out.json(res);
        if (res.reused)
          ctx.out.line(ctx.out.paint('yellow', 'Existing lease returned for this request id.'));
        else if (res.waitedMs > 0)
          ctx.out.line(ctx.out.paint('dim', `Waited ${Math.round(res.waitedMs / 1000)}s.`));
        printLease(ctx, res.lease);
        ctx.out.line();
        ctx.out.line(
          ctx.out.paint(
            'dim',
            `Release with: testlease release ${res.lease.leaseId}${ctx.owner !== res.lease.owner ? ` --owner ${res.lease.owner}` : ''}`,
          ),
        );
      },
    );

  program
    .command('renew <lease-id>')
    .description('Renew (heartbeat) a lease you own')
    .option('--ttl <duration>', 'new TTL from now (default: the lease TTL)')
    .action(async (leaseId: string, opts: { ttl?: string }) => {
      const ctx = getCtx();
      try {
        const res = await ctx.client().renew(leaseId, {
          owner: ctx.owner,
          ...(opts.ttl ? { ttlMs: parseDuration(opts.ttl) } : {}),
        });
        if (ctx.out.opts.json) return ctx.out.json(res);
        ctx.out.line(
          `${res.lease.leaseId} renewed; expires ${ctx.out.relative(res.lease.expiresAt)}`,
        );
      } catch (err) {
        process.exitCode = reportError(
          ctx.out,
          err,
          (err as TestLeaseError).code === 'LEASE_OWNERSHIP_MISMATCH' ? [OWNERSHIP_HINTS[0]!] : [],
        );
      }
    });

  program
    .command('release <lease-id>')
    .description('Release a lease (idempotent)')
    .option('-f, --force', 'release even if you are not the owner (requires lease:admin)')
    .action(async (leaseId: string, opts: { force?: boolean }) => {
      const ctx = getCtx();
      try {
        const res = await ctx
          .client()
          .release(leaseId, { owner: ctx.owner, ...(opts.force ? { force: true } : {}) });
        if (ctx.out.opts.json) return ctx.out.json(res);
        const verb =
          res.outcome === 'released'
            ? ctx.out.paint('green', 'released')
            : ctx.out.paint('dim', res.outcome.replace('_', ' '));
        ctx.out.line(`${res.lease.leaseId} ${verb}; resource ${res.lease.resourceId}`);
      } catch (err) {
        process.exitCode = reportError(
          ctx.out,
          err,
          (err as TestLeaseError).code === 'LEASE_OWNERSHIP_MISMATCH' ? OWNERSHIP_HINTS : [],
        );
      }
    });

  program
    .command('quarantine <lease-id>')
    .description('End a lease and quarantine its resource so no other test receives it')
    .requiredOption('-r, --reason <text>', 'why the resource is unsafe')
    .option('-f, --force', 'quarantine even if you are not the owner (requires lease:admin)')
    .action(async (leaseId: string, opts: { reason: string; force?: boolean }) => {
      const ctx = getCtx();
      try {
        const res = await ctx.client().quarantine(leaseId, {
          owner: ctx.owner,
          reason: opts.reason,
          ...(opts.force ? { force: true } : {}),
        });
        if (ctx.out.opts.json) return ctx.out.json(res);
        ctx.out.line(`${res.resource.id} ${ctx.out.state('QUARANTINED')}: ${opts.reason}`);
        ctx.out.line(ctx.out.paint('dim', `Restore with: testlease restore ${res.resource.id}`));
      } catch (err) {
        process.exitCode = reportError(
          ctx.out,
          err,
          (err as TestLeaseError).code === 'LEASE_OWNERSHIP_MISMATCH' ? OWNERSHIP_HINTS : [],
        );
      }
    });

  program
    .command('quarantine-resource <resource-id>')
    .description('Quarantine a resource directly (requires resource:admin)')
    .requiredOption('-r, --reason <text>', 'why the resource is unsafe')
    .option('-f, --force', 'end the active lease if there is one')
    .action(async (resourceId: string, opts: { reason: string; force?: boolean }) => {
      const ctx = getCtx();
      const res = await ctx.client().quarantineResource(resourceId, {
        reason: opts.reason,
        ...(opts.force ? { force: true } : {}),
      });
      if (ctx.out.opts.json) return ctx.out.json(res);
      ctx.out.line(
        `${res.resource.id} ${ctx.out.state(res.resource.state)}: ${res.resource.quarantine?.reason ?? opts.reason}`,
      );
    });

  program
    .command('reload')
    .description(
      'Re-read the server configuration file without restarting (requires resource:admin)',
    )
    .action(async () => {
      const ctx = getCtx();
      const res = await ctx.client().reloadConfig();
      if (ctx.out.opts.json) return ctx.out.json(res);
      ctx.out.line(
        `${ctx.out.paint('green', 'Configuration reloaded')} (#${res.reloads}): ${res.pools} pool(s), ${res.resources} resource(s); registered=${res.registered.length} updated=${res.updated.length} disabled=${res.disabled.length} enabled=${res.enabled.length}`,
      );
      for (const id of res.registered) ctx.out.line(`  + ${id}`);
      for (const id of res.updated) ctx.out.line(`  ~ ${id}`);
      for (const id of res.disabled) ctx.out.line(`  - ${id}`);
      for (const id of res.enabled) ctx.out.line(`  ↺ ${id}`);
      for (const w of res.warnings) ctx.out.line(ctx.out.paint('yellow', `  warning: ${w}`));
    });

  program
    .command('restore <resource-id>')
    .description('Restore a quarantined resource (requires resource:admin)')
    .action(async (resourceId: string) => {
      const ctx = getCtx();
      const res = await ctx.client().restoreResource(resourceId);
      if (ctx.out.opts.json) return ctx.out.json(res);
      ctx.out.line(`${res.resource.id} ${ctx.out.state(res.resource.state)}`);
    });
}
