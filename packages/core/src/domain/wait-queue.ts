import type { Tags } from '@testlease/protocol';

export interface Waiter<TReq, TRes> {
  readonly id: number;
  readonly pool: string;
  readonly owner: string;
  readonly tags: Tags;
  readonly purpose: string | undefined;
  readonly request: TReq;
  readonly enqueuedAt: number;
  resolve(result: TRes): void;
  reject(err: unknown): void;
  /** Cleanup hook (timers, abort listeners). Called exactly once when the waiter leaves the queue. */
  cleanup: (() => void) | null;
}

/**
 * In-process FIFO queue of pending acquisitions, per pool.
 *
 * Fairness guarantee: waiters for a pool are offered a freed resource in arrival order.
 * A later waiter is served before an earlier one only when the earlier one's tags do not
 * match the freed resource. There is no cross-process fairness; TestLease assumes one
 * server process per database (see ADR-0009).
 */
export class WaitQueue<TReq, TRes> {
  private readonly byPool = new Map<string, Waiter<TReq, TRes>[]>();
  private nextId = 1;

  allocateId(): number {
    return this.nextId++;
  }

  add(waiter: Waiter<TReq, TRes>): void {
    const list = this.byPool.get(waiter.pool);
    if (list) list.push(waiter);
    else this.byPool.set(waiter.pool, [waiter]);
  }

  /** Removes the waiter and runs its cleanup once. Returns false when it was not queued. */
  remove(waiter: Waiter<TReq, TRes>): boolean {
    const list = this.byPool.get(waiter.pool);
    if (!list) return false;
    const idx = list.indexOf(waiter);
    if (idx === -1) return false;
    list.splice(idx, 1);
    if (list.length === 0) this.byPool.delete(waiter.pool);
    const cleanup = waiter.cleanup;
    waiter.cleanup = null;
    cleanup?.();
    return true;
  }

  list(pool: string): readonly Waiter<TReq, TRes>[] {
    return this.byPool.get(pool) ?? [];
  }

  count(pool?: string): number {
    if (pool) return this.byPool.get(pool)?.length ?? 0;
    let n = 0;
    for (const list of this.byPool.values()) n += list.length;
    return n;
  }

  pools(): string[] {
    return [...this.byPool.keys()];
  }

  drain(): Waiter<TReq, TRes>[] {
    const all: Waiter<TReq, TRes>[] = [];
    for (const list of this.byPool.values()) all.push(...list);
    for (const w of all) this.remove(w);
    return all;
  }
}
