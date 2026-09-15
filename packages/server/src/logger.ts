import { pino, type Logger as PinoLogger, type LoggerOptions } from 'pino';
import type { Logger } from '@testlease/core';

export interface CreateLoggerOptions {
  level?: string;
  /** Pretty-print for terminals (requires pino-pretty to be installed by the caller). */
  pretty?: boolean;
  destination?: NodeJS.WritableStream;
}

/** Structured JSON logger. Redacts anything that looks like a credential just in case. */
export function createLogger(options: CreateLoggerOptions = {}): Logger & PinoLogger {
  const base: LoggerOptions = {
    level: options.level ?? 'info',
    redact: {
      paths: [
        'token',
        'secrets',
        'password',
        'authorization',
        '*.token',
        '*.secrets',
        '*.password',
        'req.headers.authorization',
      ],
      censor: '[REDACTED]',
    },
    base: { name: 'testlease' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (options.pretty) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,name' },
      },
    });
  }
  return options.destination ? pino(base, options.destination) : pino(base);
}
