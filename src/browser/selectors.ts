import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from '../config/index.js';

/**
 * Portal selectors live in data, not in code.
 *
 * Verizon's DOM will change, and when it does this should be a JSON edit rather
 * than a patch release. Refine them with `npm run verizon:probe -- --interactive`,
 * which prints what the live page actually contains, then drop the result in
 * `<DATA_DIR>/verizon-selectors.json`.
 */

export const selectorsSchema = z.object({
  /** Selectors or URL fragments meaning "you are not signed in". */
  signedOutIndicators: z.array(z.string()).default([
    'input[type="password"]',
    '#login-form',
    'form[name="login"]',
  ]),
  /** URL fragments that mean the same thing. */
  signedOutUrlFragments: z.array(z.string()).default(['signin', 'login', 'sso', 'auth/']),
  /**
   * POSITIVE evidence of an authenticated session. Required — the absence of a
   * login form is not proof of being signed in, as the public marketing site
   * demonstrates.
   */
  signedInIndicators: z.array(z.string()).default([
    'a[href*="signout"]',
    'a[href*="logout"]',
    'a:has-text("Sign Out")',
    'button:has-text("Sign Out")',
  ]),
  signedInUrlFragments: z.array(z.string()).default([
    '/mybill',
    '/my-verizon',
    '/digital/nsa/secure',
  ]),
  /**
   * Human-verification challenges. Detecting one is a full stop: this system
   * never attempts to solve or bypass CAPTCHA, MFA or bot checks.
   */
  challengeIndicators: z.array(z.string()).default([
    'iframe[src*="recaptcha"]',
    'iframe[title*="challenge"]',
    '#px-captcha',
    '[data-testid="mfa"]',
    'input[autocomplete="one-time-code"]',
  ]),
  challengeUrlFragments: z.array(z.string()).default(['captcha', 'challenge', 'verify', 'mfa', 'otp']),
  /** Clicked in order until one produces a download. */
  downloadTriggers: z.array(z.string()).default([
    'a[href$=".pdf"]',
    'a[download]',
    'a:has-text("Download PDF")',
    'button:has-text("Download PDF")',
    'a:has-text("View PDF")',
    'a:has-text("Download bill")',
    'button:has-text("Download")',
  ]),
  /** Optional: clicked before looking for a download (e.g. "View past bills"). */
  preDownloadClicks: z.array(z.string()).default([]),

});

export type VerizonSelectors = z.infer<typeof selectorsSchema>;

export const DEFAULT_SELECTORS: VerizonSelectors = selectorsSchema.parse({});

export function loadSelectors(config: Config): VerizonSelectors {
  const file = path.join(config.dataDir, 'verizon-selectors.json');
  if (!fs.existsSync(file)) return DEFAULT_SELECTORS;
  const parsed = selectorsSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new Error(
      `Invalid ${file}:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
  }
  return parsed.data;
}
