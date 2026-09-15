const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;

/**
 * Parses a duration. Numbers are milliseconds. Strings need a unit: `500ms`, `30s`, `10m`, `1h`, `1d`.
 * Compound forms such as `1h30m` are also accepted.
 */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`Invalid duration: ${input}`);
    }
    return Math.round(input);
  }
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('Invalid duration: empty string');
  const parts = trimmed.match(/\d+(?:\.\d+)?\s*(?:ms|s|m|h|d)/g);
  if (!parts || parts.join('') !== trimmed.replace(/\s+/g, '')) {
    throw new Error(
      `Invalid duration "${input}". Use a number of milliseconds or a value with a unit such as 30s, 10m, 1h.`,
    );
  }
  let total = 0;
  for (const part of parts) {
    const m = part.replace(/\s+/g, '').match(DURATION_RE);
    if (!m) throw new Error(`Invalid duration "${input}"`);
    total += Number(m[1]) * UNIT_MS[m[2]!]!;
  }
  return Math.round(total);
}

/** Compact human form, e.g. `10m`, `1h30m`, `450ms`. */
export function formatDuration(ms: number): string {
  if (ms < 0) return `-${formatDuration(-ms)}`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.join('');
}

/** Clock form used in diagnostics, e.g. `04:31` or `1:04:31`. */
export function formatClock(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const totalSeconds = Math.max(0, Math.round(Math.abs(ms) / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${sign}${h}:${mm}:${ss}` : `${sign}${mm}:${ss}`;
}
