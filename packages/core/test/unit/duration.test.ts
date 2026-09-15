import { describe, expect, it } from 'vitest';
import { formatClock, formatDuration, parseDuration } from '../../src/duration.js';

describe('parseDuration', () => {
  it('parses units', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration(' 2m 30s ')).toBe(150_000);
  });
  it('treats numbers as milliseconds', () => {
    expect(parseDuration(1500)).toBe(1500);
  });
  it('rejects unitless strings and garbage', () => {
    expect(() => parseDuration('600')).toThrow(/unit/);
    expect(() => parseDuration('ten minutes')).toThrow();
    expect(() => parseDuration('')).toThrow();
    expect(() => parseDuration(-1)).toThrow();
  });
});

describe('formatting', () => {
  it('formatDuration', () => {
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(30_000)).toBe('30s');
    expect(formatDuration(600_000)).toBe('10m');
    expect(formatDuration(5_400_000)).toBe('1h30m');
    expect(formatDuration(0)).toBe('0ms');
  });
  it('formatClock', () => {
    expect(formatClock(271_000)).toBe('04:31');
    expect(formatClock(3_871_000)).toBe('1:04:31');
    expect(formatClock(-5000)).toBe('-00:05');
  });
});
