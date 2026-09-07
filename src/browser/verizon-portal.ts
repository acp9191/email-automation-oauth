import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import type { BillAcquisition, BillSource, BillSourceContext } from '../bill/source.js';
import { MAX_PDF_BYTES, verifyPdf } from '../bill/pdf.js';
import type { Config } from '../config/index.js';
import { childLogger } from '../logging/index.js';
import { assertAllowedUrl, isAllowedUrl } from './allowlist.js';
import { isBrowserCrash, launchSession, settle, BrowserUnavailableError } from './driver.js';
import { classifyPage } from './portal-state.js';
import { loadSelectors, type VerizonSelectors } from './selectors.js';

/**
 * Downloads the bill PDF from the Verizon portal.
 *
 * ATTENDED ONLY. Verizon rejects programmatic sign-in and serves headless
 * browsers a blank page, and its session does not survive a browser restart —
 * all three were verified against the live site. So a human signs in, once, in
 * the browser window this opens, and everything after that is automatic.
 *
 * Hard rules, enforced below rather than merely intended:
 *  - Navigation is restricted to the configured Verizon hosts.
 *  - Any human-verification challenge is waited on, never solved or bypassed.
 *  - No Verizon password is read, requested, or stored. There is no code path
 *    that could accept one.
 *  - Downloaded bytes must verify as a real PDF before they are returned.
 */

/** How long attended mode waits for a human to finish signing in. */
const INTERACTIVE_WAIT_MS = 5 * 60 * 1000;

export class VerizonPortalBillSource implements BillSource {
  readonly id = 'browser' as const;
  readonly description = 'Verizon portal, with a human sign-in';
  private readonly log = childLogger({ component: 'browser.verizon' });

  constructor(
    private readonly config: Config,
    /** Without this the portal cannot be reached at all; see the class note. */
    private readonly interactive = false,
  ) {}

  async acquire(_context: BillSourceContext): Promise<BillAcquisition> {
    if (!this.config.verizon.browserEnabled) {
      return {
        status: 'needs_intervention',
        reason: 'this host cannot drive a browser (BROWSER_ENABLED=false)',
        instructions: [
          'A new Verizon bill was detected, but this machine has no GUI browser',
          'and Verizon requires a human sign-in.',
          '',
          'On a machine with a display, run:',
          '  npm run run-verizon -- --interactive',
          '',
          'Nothing was sent. This is the only step that needs you.',
        ].join('\n'),
      };
    }

    if (!this.interactive) {
      return {
        status: 'needs_intervention',
        reason: 'the Verizon portal requires a human sign-in',
        instructions: [
          'The bill is behind a My Verizon login, and Verizon does not permit',
          'automated sign-in. Two ways forward, both of which automate everything',
          'except the login itself:',
          '',
          '  npm run run-verizon -- --interactive     open a browser, sign in (~30s)',
          '  npm run run-verizon -- --bill <path>     download by hand, then this',
          '',
          'Nothing was sent, and no credentials were used, stored, or requested.',
        ].join('\n'),
      };
    }

    const selectors = loadSelectors(this.config);

    let billingUrl: URL;
    try {
      billingUrl = assertAllowedUrl(this.config.verizon.billingUrl, this.config.verizonAllowedDomains);
    } catch (error) {
      return {
        status: 'unavailable',
        reason: `VERIZON_BILLING_URL is not acceptable: ${(error as Error).message}`,
      };
    }

    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verizon-bill-'));
    let session;
    try {
      session = await launchSession(this.config, { enforceAllowlist: true, downloadDir });
    } catch (error) {
      if (error instanceof BrowserUnavailableError) {
        return { status: 'unavailable', reason: error.message };
      }
      // Playwright is installed but its browser binary is not — the usual state
      // in a slim container. Report it as configuration, not as a bill problem.
      if (/executable doesn't exist|please run the following command/i.test(String(error))) {
        return {
          status: 'needs_intervention',
          reason: 'the Chromium binary is not installed on this host',
          instructions: [
            'Playwright is present but its browser is not installed here.',
            '',
            'If this is a headless server, set BROWSER_ENABLED=false and run the',
            'browser step on a machine with a display instead.',
            '',
            'To install it here anyway: npx playwright install chromium',
          ].join('\n'),
        };
      }
      throw error;
    }

    try {
      await session.page.goto(billingUrl.toString(), { waitUntil: 'domcontentloaded' });
      await settle(session.page);

      let classification = await classifyPage(session.page, selectors);
      this.log.info({ state: classification.state }, 'portal state');

      if (classification.state !== 'ready') {
        this.log.info(
          { waitMinutes: INTERACTIVE_WAIT_MS / 60_000 },
          'sign in (and complete any MFA) in the browser window — waiting',
        );
        classification = await this.waitForReady(session.page, selectors);
      }

      if (classification.state !== 'ready') {
        return {
          status: 'needs_intervention',
          reason: `sign-in was not completed within ${INTERACTIVE_WAIT_MS / 60_000} minutes`,
          instructions: [
            'The browser never reached a signed-in bill page.',
            '',
            'Re-run and complete the sign-in, or skip the browser entirely:',
            '  npm run run-verizon -- --bill <path>',
          ].join('\n'),
        };
      }

      for (const selector of selectors.preDownloadClicks) {
        await session.page
          .locator(selector)
          .first()
          .click({ timeout: 10_000 })
          .catch(() => this.log.debug({ selector }, 'pre-download click did not match'));
      }

      const content = await this.download(session.page, selectors);
      if (!content) {
        return {
          status: 'needs_intervention',
          reason: 'signed in, but no bill download control matched the configured selectors',
          instructions: [
            'The session is valid but the download control was not found —',
            'Verizon has probably changed their page.',
            '',
            '  npm run verizon:probe -- --interactive    see what the live page offers',
            '',
            'Then update <DATA_DIR>/verizon-selectors.json — no code change needed.',
          ].join('\n'),
        };
      }

      const check = verifyPdf(content);
      if (!check.valid) {
        return { status: 'unavailable', reason: `portal download failed PDF verification: ${check.reason}` };
      }

      return {
        status: 'acquired',
        artifact: {
          content,
          sha256: check.sha256,
          byteLength: check.byteLength,
          origin: this.id,
          originDetail: `Verizon portal (${billingUrl.origin}${billingUrl.pathname})`,
          suggestedName: null,
        },
      };
    } catch (error) {
      if (!isBrowserCrash(error)) throw error;
      return {
        status: 'needs_intervention',
        reason: `the browser process died mid-run: ${(error as Error).message}`,
        instructions: [
          'Chromium exited unexpectedly. This is a browser-level failure, not a',
          'problem with the bill data. Re-running usually works.',
          '',
          'If it keeps crashing, use the path that needs no browser at all:',
          '  npm run run-verizon -- --bill <path>',
        ].join('\n'),
      };
    } finally {
      await session.close();
      fs.rmSync(downloadDir, { recursive: true, force: true });
    }
  }

  /**
   * Polls until the page shows a signed-in session. A challenge encountered
   * here is simply waited on — the human in front of the browser solves it.
   * Nothing is auto-solved or auto-dismissed.
   */
  private async waitForReady(page: Page, selectors: VerizonSelectors) {
    const deadline = Date.now() + INTERACTIVE_WAIT_MS;
    let latest = await classifyPage(page, selectors);
    while (Date.now() < deadline && latest.state !== 'ready') {
      await page.waitForTimeout(3000).catch(() => undefined);
      latest = await classifyPage(page, selectors).catch(() => latest);
    }
    if (latest.state === 'ready') await settle(page);
    return latest;
  }

  /**
   * Two strategies, cheapest first.
   *
   * 1. A direct PDF anchor — fetched through the browser's own request context
   *    so the session cookies apply, with the href re-checked against the
   *    allowlist because it came from the page.
   * 2. Clicking a download control and capturing the download event.
   */
  private async download(page: Page, selectors: VerizonSelectors): Promise<Buffer | null> {
    // Runs in the page; typed structurally because this project does not pull
    // in the DOM lib.
    const anchors = await page.locator('a[href]').evaluateAll((nodes) =>
      nodes.map((node) => (node as unknown as { href?: string }).href ?? '').filter(Boolean),
    );
    const pdfHrefs = anchors.filter(
      (href) => /\.pdf(\?|$)/i.test(href) || /pdf/i.test(new URL(href, page.url()).pathname),
    );

    for (const href of pdfHrefs.slice(0, 5)) {
      if (!isAllowedUrl(href, this.config.verizonAllowedDomains)) {
        this.log.warn('skipping a pdf link outside the allowlist');
        continue;
      }
      const response = await page.context().request.get(href, { timeout: this.config.verizon.navTimeoutMs });
      if (!response.ok()) continue;
      const body = Buffer.from(await response.body());
      if (body.byteLength > MAX_PDF_BYTES) continue;
      if (verifyPdf(body).valid) {
        this.log.info({ bytes: body.byteLength }, 'bill fetched via direct pdf href');
        return body;
      }
    }

    for (const selector of selectors.downloadTriggers) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) continue;
      try {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: this.config.verizon.navTimeoutMs }),
          locator.click({ timeout: 10_000 }),
        ]);
        const file = await download.path();
        if (!file) continue;
        const body = fs.readFileSync(file);
        if (body.byteLength > MAX_PDF_BYTES) continue;
        this.log.info({ selector, bytes: body.byteLength }, 'bill captured from download event');
        return body;
      } catch {
        this.log.debug({ selector }, 'download trigger did not produce a download');
      }
    }

    return null;
  }
}
