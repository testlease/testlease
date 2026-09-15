import type { Metadata } from '@testlease/protocol';
import type { TestLeaseConfig } from '../config/schema.js';
import type { Logger } from '../logger.js';
import { noopLogger } from '../logger.js';
import type { SqliteStore } from '../store/sqlite-store.js';

export interface SyncSummary {
  pools: number;
  resources: number;
  registered: string[];
  updated: string[];
  disabled: string[];
  enabled: string[];
  absentPools: string[];
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function changedKeys(
  a: Metadata | Record<string, string>,
  b: Metadata | Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => !sameJson(a[k], b[k])).sort();
}

/**
 * Makes the database reflect the configuration file. Configuration is the source of truth for
 * *what exists* (pools, resources, metadata, secret references); the database is the source of
 * truth for *runtime state* (leases, quarantine). Removed resources are disabled, never deleted,
 * so their lease history survives.
 */
export function syncConfig(
  store: SqliteStore,
  config: TestLeaseConfig,
  now: number,
  logger: Logger = noopLogger,
): SyncSummary {
  return store.transaction(() => {
    const summary: SyncSummary = {
      pools: 0,
      resources: 0,
      registered: [],
      updated: [],
      disabled: [],
      enabled: [],
      absentPools: [],
    };

    const configuredPools = new Set(Object.keys(config.pools));
    for (const [name, pool] of Object.entries(config.pools)) {
      store.upsertPool(
        {
          name,
          description: pool.description ?? null,
          defaultTtlMs: pool.defaultTtl,
          maxTtlMs: pool.maxTtl,
        },
        now,
      );
      summary.pools++;
    }
    for (const existing of store.listPools()) {
      if (!configuredPools.has(existing.name) && existing.present) {
        store.markPoolAbsent(existing.name, now);
        summary.absentPools.push(existing.name);
      }
    }

    const configuredResources = new Set<string>();
    for (const [poolName, pool] of Object.entries(config.pools)) {
      for (const resource of pool.resources) {
        configuredResources.add(resource.id);
        summary.resources++;
        const existing = store.getResource(resource.id);
        if (!existing) {
          store.insertResource(
            {
              id: resource.id,
              pool: poolName,
              state: resource.enabled ? 'AVAILABLE' : 'DISABLED',
              enabled: resource.enabled,
              metadata: resource.metadata,
              secretRefs: resource.secrets,
            },
            now,
          );
          store.insertEvent({
            at: now,
            type: 'RESOURCE_REGISTERED',
            pool: poolName,
            resourceId: resource.id,
            details: {
              enabled: resource.enabled,
              metadataKeys: Object.keys(resource.metadata).sort(),
              secretKeys: Object.keys(resource.secrets).sort(),
            },
          });
          summary.registered.push(resource.id);
          continue;
        }

        const metadataChanges = changedKeys(existing.metadata, resource.metadata);
        const secretChanges = changedKeys(existing.secretRefs, resource.secrets);
        const poolChanged = existing.pool !== poolName;
        store.updateResourceConfig(
          {
            id: resource.id,
            pool: poolName,
            enabled: resource.enabled,
            metadata: resource.metadata,
            secretRefs: resource.secrets,
          },
          now,
        );
        if (metadataChanges.length || secretChanges.length || poolChanged) {
          store.insertEvent({
            at: now,
            type: 'RESOURCE_UPDATED',
            pool: poolName,
            resourceId: resource.id,
            details: {
              ...(metadataChanges.length ? { metadataKeys: metadataChanges } : {}),
              ...(secretChanges.length ? { secretKeys: secretChanges } : {}),
              ...(poolChanged ? { previousPool: existing.pool } : {}),
            },
          });
          summary.updated.push(resource.id);
        }
        if (resource.enabled && !existing.enabled) {
          if (existing.state === 'DISABLED') store.setResourceState(resource.id, 'AVAILABLE', now);
          store.insertEvent({
            at: now,
            type: 'RESOURCE_ENABLED',
            pool: poolName,
            resourceId: resource.id,
          });
          summary.enabled.push(resource.id);
        } else if (!resource.enabled && existing.enabled) {
          if (existing.state === 'AVAILABLE') store.setResourceState(resource.id, 'DISABLED', now);
          store.insertEvent({
            at: now,
            type: 'RESOURCE_DISABLED',
            pool: poolName,
            resourceId: resource.id,
            details: {
              reason: 'enabled: false in configuration',
              deferred: existing.state !== 'AVAILABLE',
            },
          });
          summary.disabled.push(resource.id);
        }
      }
    }

    for (const existing of store.listResources()) {
      if (configuredResources.has(existing.id) || !existing.enabled) continue;
      store.updateResourceConfig(
        {
          id: existing.id,
          pool: existing.pool,
          enabled: false,
          metadata: existing.metadata,
          secretRefs: existing.secretRefs,
        },
        now,
      );
      if (existing.state === 'AVAILABLE') store.setResourceState(existing.id, 'DISABLED', now);
      store.insertEvent({
        at: now,
        type: 'RESOURCE_DISABLED',
        pool: existing.pool,
        resourceId: existing.id,
        details: { reason: 'removed from configuration', deferred: existing.state !== 'AVAILABLE' },
      });
      summary.disabled.push(existing.id);
      logger.warn(
        {
          event: 'config.resource_removed',
          resourceId: existing.id,
          pool: existing.pool,
          state: existing.state,
        },
        existing.state === 'LEASED'
          ? 'resource removed from configuration while leased; it will be disabled when the lease ends'
          : 'resource removed from configuration; disabled (history kept)',
      );
    }

    return summary;
  });
}
