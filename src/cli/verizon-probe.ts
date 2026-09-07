import { getConfig } from '../config/index.js';
import { assertAllowedUrl } from '../browser/allowlist.js';
import { launchSession, settle } from '../browser/driver.js';
import { classifyPage } from '../browser/portal-state.js';
import { loadSelectors } from '../browser/selectors.js';

/* eslint-disable no-console */

/**
 * Read-only reconnaissance of the billing page, using the saved session.
 *
 * Prints the controls that plausibly download a bill so real selectors can be
 * written into `<DATA_DIR>/verizon-selectors.json`. It clicks nothing and
 * downloads nothing. Link text is truncated and query strings dropped, because
 * portal URLs carry account identifiers.
 */
/** Prints input/button attributes so real selectors can be written. Never values. */
async function dumpFormControls(page: import('playwright').Page): Promise<void> {
  const inputs = await page.locator('input').evaluateAll((nodes) =>
    nodes.map((node) => {
      const el = node as unknown as { getAttribute(name: string): string | null };
      return {
        id: el.getAttribute('id'),
        name: el.getAttribute('name'),
        type: el.getAttribute('type'),
        autocomplete: el.getAttribute('autocomplete'),
        placeholder: el.getAttribute('placeholder'),
        ariaLabel: el.getAttribute('aria-label'),
      };
    }),
  );

  console.log(`\n  <input> elements (${inputs.length})`);
  for (const input of inputs.slice(0, 20)) {
    const parts = Object.entries(input)
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}=${String(value).slice(0, 40)}`);
    console.log(`    ${parts.join('  ') || '(no attributes)'}`);
  }

  const buttons = await page.locator('button, input[type="submit"]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const el = node as unknown as {
        getAttribute(name: string): string | null;
        textContent: string | null;
      };
      return {
        id: el.getAttribute('id'),
        name: el.getAttribute('name'),
        type: el.getAttribute('type'),
        text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40),
      };
    }),
  );

  // Site-wide navigation drowns out the form; drop it.
  const formButtons = buttons.filter((button) => !(button.id ?? '').startsWith('gnav20'));
  console.log(`\n  buttons (${formButtons.length} shown, ${buttons.length} total incl. site nav)`);
  for (const button of formButtons.slice(0, 25)) {
    const parts = Object.entries(button)
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}=${String(value)}`);
    console.log(`    ${parts.join('  ') || '(no attributes)'}`);
  }

  const frames = page.frames().length;
  if (frames > 1) {
    console.log(`\n  NOTE: page has ${frames} frames — the form may live in an iframe.`);
    for (const frame of page.frames().slice(0, 6)) {
      try {
        console.log(`    ${new URL(frame.url()).origin}${new URL(frame.url()).pathname}`);
      } catch {
        /* about:blank */
      }
    }
  }
}

export async function verizonProbeCommand(interactive = false): Promise<number> {
  const config = getConfig();
  const selectors = loadSelectors(config);

  const billingUrl = assertAllowedUrl(config.verizon.billingUrl, config.verizonAllowedDomains);
  const session = await launchSession(config, { enforceAllowlist: true });

  try {
    await session.page.goto(billingUrl.toString(), { waitUntil: 'domcontentloaded' });
      await settle(session.page);
    const { page } = session;

    let classification = await classifyPage(page, selectors);
    const parsed = new URL(page.url());
    console.log(`\n  Landed on: ${parsed.origin}${parsed.pathname}`);
    console.log(`  Title:     ${(await page.title()).slice(0, 100)}`);
    console.log(`  State:     ${classification.state}${classification.evidence ? ` (${classification.evidence})` : ''}`);

    if (classification.state !== 'ready' && interactive) {
      // Wait for a human so the BILL page can be inspected, which is where the
      // download selectors actually live.
      console.log('\n  Sign in in the browser window; waiting up to 5 minutes...\n');
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline && (await classifyPage(page, selectors)).state !== 'ready') {
        await page.waitForTimeout(3000);
      }
      await settle(page);
      classification = await classifyPage(page, selectors);
      console.log(`  State now: ${classification.state}`);
    }

    if (classification.state !== 'ready') {
      // Dump whatever page we did land on; its structure is the diagnostic.
      await dumpFormControls(page);
      console.log('\n  Not signed in. Re-run with --interactive to sign in and inspect');
      console.log('  the bill page itself. Attribute names only; values are never read.\n');
      return 1;
    }

    const links = await page.locator('a[href]').evaluateAll((nodes) =>
      nodes
        .map((node) => {
          const anchor = node as unknown as { href?: string; textContent?: string | null };
          return { href: anchor.href ?? '', text: (anchor.textContent ?? '').trim().replace(/\s+/g, ' ') };
        })
        .filter((entry) => entry.href),
    );

    const interesting = links.filter(
      (link) => /bill|statement|invoice|pdf|download/i.test(`${link.href} ${link.text}`),
    );

    console.log(`\n  Bill-ish links (${interesting.length} of ${links.length} total)`);
    for (const link of interesting.slice(0, 25)) {
      let display = link.href.slice(0, 80);
      try {
        const url = new URL(link.href);
        display = `${url.origin}${url.pathname}`;
      } catch {
        /* keep raw */
      }
      console.log(`    "${link.text.slice(0, 60)}"`);
      console.log(`       ${display}`);
    }

    const buttons = await page.locator('button').evaluateAll((nodes) =>
      nodes
        .map((node) => ((node as unknown as { textContent?: string | null }).textContent ?? '').trim().replace(/\s+/g, ' '))
        .filter((text) => text.length > 0 && /bill|statement|pdf|download|view/i.test(text)),
    );

    console.log(`\n  Bill-ish buttons (${buttons.length})`);
    for (const text of [...new Set(buttons)].slice(0, 25)) {
      console.log(`    "${text.slice(0, 70)}"`);
    }

    console.log('\n  Configured downloadTriggers, and whether they match here:');
    for (const selector of selectors.downloadTriggers) {
      const count = await page.locator(selector).count().catch(() => -1);
      console.log(`    ${count > 0 ? 'MATCH' : count === 0 ? '  -  ' : ' err '}  ${selector}  (${count})`);
    }

    console.log('\n  Nothing was clicked or downloaded.\n');
    return 0;
  } finally {
    await session.close();
  }
}
