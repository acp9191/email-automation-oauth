import path from 'node:path';
import { z } from 'zod';

/**
 * Configuration is loaded once, validated once, and then treated as immutable.
 * Anything security-relevant (recipients, allowed domains, dry-run) lives here
 * so that it can never be influenced by the contents of an email.
 */

function loadDotEnv(): void {
  try {
    process.loadEnvFile(path.resolve(process.cwd(), '.env'));
  } catch {
    // No .env file is fine — env vars may come from the shell or Docker.
  }
}

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

const boolish = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => ['true', 'false', '1', '0', 'yes', 'no'].includes(value), {
    message: 'must be true/false',
  })
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const schema = z.object({
  NODE_ENV: z.string().default('development'),

  // Fails safe: if DRY_RUN is unset or malformed we do NOT send email.
  DRY_RUN: boolish.default('true'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  LOG_PRETTY: boolish.default('true'),

  DATA_DIR: z.string().default('./data'),

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_OAUTH_PORT: z.coerce.number().int().min(1024).max(65535).default(4141),

  GMAIL_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  GMAIL_MAX_RESULTS: z.coerce.number().int().min(1).max(200).default(25),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),

  WORK_EMAIL: z.string().default(''),
  VERIZON_ALLOWED_DOMAINS: z
    .string()
    .default('verizon.com,www.verizon.com,secure.verizon.com'),

  NOTIFY_EMAIL: z.string().default(''),

  // --- Verizon portal automation ---
  VERIZON_BILLING_URL: z.string().default('https://www.verizon.com/my-verizon/bill'),
  VERIZON_NAV_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(180_000).default(45_000),
  // Set false on a headless host (a VM). Verizon needs a human at a real
  // browser, so a GUI-less machine should say so rather than fail obscurely.
  BROWSER_ENABLED: boolish.default('true'),
});

export interface Config {
  nodeEnv: string;
  dryRun: boolean;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  logPretty: boolean;
  dataDir: string;
  dbPath: string;
  tokenDir: string;
  artifactDir: string;
  google: {
    clientId: string;
    clientSecret: string;
    oauthPort: number;
  };
  gmail: {
    lookbackDays: number;
    maxResults: number;
    pollIntervalSeconds: number;
  };
  workEmail: string;
  verizonAllowedDomains: string[];
  notifyEmail: string;
  verizon: {
    billingUrl: string;
    navTimeoutMs: number;
    browserEnabled: boolean;
  };
}

export class ConfigError extends Error {}

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration:\n${detail}`);
  }

  const raw = parsed.data;
  const dataDir = path.resolve(process.cwd(), raw.DATA_DIR);

  return {
    nodeEnv: raw.NODE_ENV,
    dryRun: raw.DRY_RUN,
    logLevel: raw.LOG_LEVEL,
    logPretty: raw.LOG_PRETTY,
    dataDir,
    dbPath: path.join(dataDir, 'automation.sqlite'),
    tokenDir: path.join(dataDir, 'tokens'),
    artifactDir: path.join(dataDir, 'artifacts'),
    google: {
      clientId: raw.GOOGLE_CLIENT_ID.trim(),
      clientSecret: raw.GOOGLE_CLIENT_SECRET.trim(),
      oauthPort: raw.GOOGLE_OAUTH_PORT,
    },
    gmail: {
      lookbackDays: raw.GMAIL_LOOKBACK_DAYS,
      maxResults: raw.GMAIL_MAX_RESULTS,
      pollIntervalSeconds: raw.POLL_INTERVAL_SECONDS,
    },
    workEmail: raw.WORK_EMAIL.trim().toLowerCase(),
    verizonAllowedDomains: csv(raw.VERIZON_ALLOWED_DOMAINS),
    notifyEmail: raw.NOTIFY_EMAIL.trim().toLowerCase(),
    verizon: {
      billingUrl: raw.VERIZON_BILLING_URL.trim(),
      navTimeoutMs: raw.VERIZON_NAV_TIMEOUT_MS,
      browserEnabled: raw.BROWSER_ENABLED,
    },
  };
}

/** Loads `.env` then returns the process-wide config, memoised. */
export function getConfig(): Config {
  if (!cached) {
    loadDotEnv();
    cached = loadConfig(process.env);
  }
  return cached;
}

/** Test helper — clears the memoised config. */
export function resetConfigCache(): void {
  cached = undefined;
}

/** Throws unless Google OAuth client credentials are present. */
export function requireGoogleCredentials(config: Config): void {
  if (!config.google.clientId || !config.google.clientSecret) {
    throw new ConfigError(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set. See README "Gmail OAuth setup".',
    );
  }
}

/** Throws unless a work email is configured. Never inferred from email content. */
export function requireWorkEmail(config: Config): string {
  if (!config.workEmail) {
    throw new ConfigError(
      'WORK_EMAIL must be set — the reimbursement recipient is configuration-only and is never read from an email.',
    );
  }
  return config.workEmail;
}
