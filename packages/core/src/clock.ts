/** Time source. All expiry decisions use the server clock, never client clocks. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

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
