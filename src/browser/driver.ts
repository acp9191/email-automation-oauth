import fs from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { Config } from '../config/index.js';
import { childLogger } from '../logging/index.js';
import { isAllowedUrl } from './allowlist.js';

/**
 * Playwright session management.
 *
 * Contexts are EPHEMERAL. A persistent profile was tried and removed: Verizon's
 * session does not survive a browser restart, so the profile carried no useful
 * state — only tracking cookies and, after an unclean shutdown, corruption that
 * segfaulted Chromium on launch. Nothing is stored between runs.
 *
 * Playwright is imported dynamically so the rest of the system keeps working
 * when it is not installed.
 */

export interface Session {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export class BrowserUnavailableError extends Error {}

const CRASH_SIGNATURES = [
  'target page, context or browser has been closed',
  'browser has been closed',
  'target closed',
  'browser closed',
  'crashed',
  'connection closed',
];

/** True if an error looks like the browser process dying rather than a page problem. */
export function isBrowserCrash(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return CRASH_SIGNATURES.some((signature) => message.includes(signature));
}

async function loadPlaywright(): Promise<typeof import('playwright')> {
  try {
    return await import('playwright');
  } catch {
    throw new BrowserUnavailableError(
      'Playwright is not installed. Run: npm install playwright && npx playwright install chromium',
    );
  }
}

export interface LaunchOptions {
  /**
   * Abort top-level navigations to hosts outside the allowlist.
   *
   * Relaxed while a human is signing in, because real MFA often redirects to an
   * identity provider on another host and a person is making every decision.
   */
  enforceAllowlist: boolean;
  downloadDir?: string;
}

/**
 * Always headed. Verizon serves a blank page to headless Chromium (verified:
 * zero inputs, empty title), so headless is not a usable mode here.
 */
export async function launchSession(config: Config, options: LaunchOptions): Promise<Session> {
  const log = childLogger({ component: 'browser' });
  const { chromium } = await loadPlaywright();

  const browser: Browser = await chromium.launch({
    headless: false,
    ...(options.downloadDir ? { downloadsPath: options.downloadDir } : {}),
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
  });

  context.setDefaultNavigationTimeout(config.verizon.navTimeoutMs);
  context.setDefaultTimeout(config.verizon.navTimeoutMs);

  if (options.enforceAllowlist) {
    await context.route('**/*', async (route) => {
      const request = route.request();
      // Only top-level document loads are gated; sub-resources (images, CSS,
      // scripts) are left alone or the page simply will not render.
      if (request.isNavigationRequest() && request.resourceType() === 'document') {
        if (!isAllowedUrl(request.url(), config.verizonAllowedDomains)) {
          log.warn({ blocked: new URL(request.url()).host }, 'blocked navigation outside allowlist');
          await route.abort('blockedbyclient');
          return;
        }
      }
      await route.continue();
    });
  }

  const page = await context.newPage();

  // Log where we go, never what is on the page.
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      try {
        log.debug({ host: new URL(frame.url()).host }, 'navigated');
      } catch {
        /* about:blank and friends */
      }
    }
  });
  page.on('crash', () => log.error('the page process crashed'));

  return {
    context,
    page,
    close: async () => {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}

/**
 * Waits for a client-rendered page to settle.
 *
 * The Verizon bill page is a hash-routed SPA: `domcontentloaded` fires long
 * before the router has drawn anything. `networkidle` is unreliable on ad-heavy
 * pages, so it is attempted with a short budget and a fixed settle applied
 * regardless.
 */
export async function settle(page: Page, quietMs = 2500): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(quietMs);
}

/** Kept so callers need not import node:fs just to make a download directory. */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
