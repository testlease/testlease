import { styleText } from 'node:util';
import { isTestLeaseError, type TestLeaseError } from '@testlease/protocol';
import { formatClock, formatDuration } from '@testlease/core';

export interface OutputOptions {
  json: boolean;
  color: boolean;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export type Style = Parameters<typeof styleText>[0];

export class Output {
  readonly opts: OutputOptions;
  constructor(opts: OutputOptions) {
    this.opts = opts;
  }

  paint(style: Style, text: string): string {
    return this.opts.color ? styleText(style, text) : text;
  }

  line(text = ''): void {
    this.opts.stdout.write(`${text}\n`);
  }

  err(text: string): void {
    this.opts.stderr.write(`${text}\n`);
  }

  json(value: unknown): void {
    this.opts.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }

  /** Renders aligned columns. `rows` are string arrays; the first row is the header. */
  table(rows: string[][], options: { indent?: string } = {}): void {
    if (rows.length === 0) return;
    const widths: number[] = [];
    for (const row of rows)
      row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
    rows.forEach((row, r) => {
      const text = row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!)))
        .join('   ');
      this.line(`${options.indent ?? ''}${r === 0 ? this.paint('bold', text) : text}`);
    });
  }

  state(state: string): string {
    switch (state) {
      case 'AVAILABLE':
      case 'ACTIVE':
        return this.paint('green', state);
      case 'LEASED':
        return this.paint('yellow', state);
      case 'QUARANTINED':
      case 'EXPIRED':
        return this.paint('red', state);
      case 'DISABLED':
      case 'RELEASED':
        return this.paint('dim', state);
      default:
        return state;
    }
  }

  relative(epochMs: number, now = Date.now()): string {
    const diff = epochMs - now;
    return diff >= 0 ? `in ${formatClock(diff)}` : `${formatDuration(-diff)} ago`;
  }

  when(epochMs: number): string {
    return new Date(epochMs).toISOString();
  }
}

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NO_RESOURCE: 3,
  UNAVAILABLE: 4,
} as const;

/** Prints an error consistently and maps it to an exit code. Never prints secrets. */
export function reportError(out: Output, err: unknown, hints: string[] = []): number {
  if (isTestLeaseError(err)) {
    const e = err as TestLeaseError;
    if (out.opts.json) {
      out.json({ error: { code: e.code, message: e.message, details: e.details } });
    } else {
      out.err(`${out.paint(['red', 'bold'], `Error ${e.code}`)}: ${e.message}`);
      for (const h of hints) out.err(out.paint('dim', `  hint: ${h}`));
    }
    switch (e.code) {
      case 'ACQUIRE_TIMEOUT':
      case 'POOL_EXHAUSTED':
      case 'NO_MATCHING_RESOURCE':
        return EXIT.NO_RESOURCE;
      case 'UNAVAILABLE':
      case 'SERVER_SHUTTING_DOWN':
        return EXIT.UNAVAILABLE;
      case 'INVALID_REQUEST':
        return EXIT.USAGE;
      default:
        return EXIT.ERROR;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  if (out.opts.json) out.json({ error: { code: 'CLI_ERROR', message } });
  else out.err(`${out.paint(['red', 'bold'], 'Error')}: ${message}`);
  return EXIT.ERROR;
}

/** Parses repeated `key=value` options into a record. */
export function parseKeyValues(values: string[] | undefined, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of values ?? []) {
    const idx = raw.indexOf('=');
    if (idx <= 0) throw new Error(`Invalid ${what} "${raw}"; expected key=value`);
    out[raw.slice(0, idx)] = raw.slice(idx + 1);
  }
  return out;
}
