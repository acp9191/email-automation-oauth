import type { VerizonSelectors } from './selectors.js';

/**
 * Classifies what the portal is showing us.
 *
 * Kept free of Playwright types (see `PageLike`) so it can be tested against a
 * fake page — the decision that matters most here, "stop, a human is needed",
 * deserves tests that do not require a browser.
 */

export interface LocatorLike {
  count(): Promise<number>;
}

export interface PageLike {
  url(): string;
  locator(selector: string): LocatorLike;
}

/**
 * `unknown` is a real answer, not a failure: we are somewhere that shows
 * neither a login wall nor proof of a session — the public site, say. Callers
 * must treat it as "do not proceed", never as "probably fine".
 */
export type PortalState = 'ready' | 'signed-out' | 'challenge' | 'unknown';

export interface Classification {
  state: PortalState;
  /** Which indicator fired, for the operator's benefit. Never page content. */
  evidence: string | null;
}

async function firstMatching(page: PageLike, selectors: string[]): Promise<string | null> {
  for (const selector of selectors) {
    try {
      if ((await page.locator(selector).count()) > 0) return selector;
    } catch {
      // A selector that Playwright cannot parse is skipped, not fatal.
    }
  }
  return null;
}

function urlContains(url: string, fragments: string[]): string | null {
  const lower = url.toLowerCase();
  return fragments.find((fragment) => lower.includes(fragment.toLowerCase())) ?? null;
}

export async function classifyPage(page: PageLike, selectors: VerizonSelectors): Promise<Classification> {
  const url = page.url();

  // Challenge first. If Verizon is asking a human to prove something, that is
  // the answer regardless of what else is on the page — we never try to solve it.
  const challengeUrl = urlContains(url, selectors.challengeUrlFragments);
  if (challengeUrl) return { state: 'challenge', evidence: `url contains "${challengeUrl}"` };

  const challengeSelector = await firstMatching(page, selectors.challengeIndicators);
  if (challengeSelector) return { state: 'challenge', evidence: `matched ${challengeSelector}` };

  const signedOutUrl = urlContains(url, selectors.signedOutUrlFragments);
  if (signedOutUrl) return { state: 'signed-out', evidence: `url contains "${signedOutUrl}"` };

  const signedOutSelector = await firstMatching(page, selectors.signedOutIndicators);
  if (signedOutSelector) return { state: 'signed-out', evidence: `matched ${signedOutSelector}` };

  // Require positive proof of a session before declaring the page usable.
  const signedInUrl = urlContains(url, selectors.signedInUrlFragments);
  if (signedInUrl) return { state: 'ready', evidence: `url contains "${signedInUrl}"` };

  const signedInSelector = await firstMatching(page, selectors.signedInIndicators);
  if (signedInSelector) return { state: 'ready', evidence: `matched ${signedInSelector}` };

  return { state: 'unknown', evidence: 'no sign-in or sign-out evidence on this page' };
}
