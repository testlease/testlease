/** Time source. All expiry decisions use the server clock, never client clocks. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export interface MonotonicClockOptions {
  wall?: () => number;
  mono?: () => number;
}

/**
 * Wall-clock time at construction plus monotonic elapsed time since then. Expiry decisions made
 * with this clock cannot be disturbed by NTP corrections or manual clock changes while the
 * process runs: a forward jump would otherwise expire healthy leases en masse, a backward jump
 * would extend dead ones. After a restart the clock re-anchors to the wall clock, which is what
 * the persisted `expiresAt` values are expressed in.
 */
export class MonotonicClock implements Clock {
  private readonly wall: () => number;
  private readonly mono: () => number;
  private readonly anchorWall: number;
  private readonly anchorMono: number;

  constructor(options: MonotonicClockOptions = {}) {
    this.wall = options.wall ?? (() => Date.now());
    this.mono = options.mono ?? (() => performance.now());
    this.anchorWall = this.wall();
    this.anchorMono = this.mono();
  }

  now(): number {
    return Math.round(this.anchorWall + (this.mono() - this.anchorMono));
  }

  /** How far the system wall clock has moved away from this clock since startup. */
  wallDriftMs(): number {
    return this.wall() - this.now();
  }
}

/** Deterministic clock for tests. */
export class ManualClock implements Clock {
  private t: number;

  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }

  set(epochMs: number): void {
    this.t = epochMs;
  }
}
