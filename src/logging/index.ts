import pino, { type Logger } from 'pino';
import { getConfig } from '../config/index.js';

/**
 * Structured logging.
 *
 * Two rules this module enforces by construction:
 *  1. Known-sensitive keys are redacted before they reach a transport.
 *  2. Email bodies and attachment bytes are never logged — callers should log
 *     `summarise()` output (ids, lengths, hashes) instead of raw content.
 */

const REDACTED_PATHS = [
  'access_token',
  'refresh_token',
  'client_secret',
  'clientSecret',
  'password',
  'authorization',
  'cookie',
  'cookies',
  '*.access_token',
  '*.refresh_token',
  '*.client_secret',
  '*.clientSecret',
  '*.password',
  '*.authorization',
  'headers.authorization',
  'headers.cookie',
];

let root: Logger | undefined;

export function getLogger(): Logger {
  if (!root) {
    const config = getConfig();
    root = pino({
      level: config.logLevel,
      redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
      base: { service: 'personal-automation' },
      ...(config.logPretty
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
            },
          }
        : {}),
    });
  }
  return root;
}

export function childLogger(bindings: Record<string, unknown>): Logger {
  return getLogger().child(bindings);
}

/** Reduces an error to something safe and useful to log or notify on. */
export function describeError(error: unknown): { message: string; name: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'UnknownError', message: String(error) };
}

/** Test helper — drops the memoised logger. */
export function resetLogger(): void {
  root = undefined;
}
