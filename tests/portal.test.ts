import { describe, expect, it } from 'vitest';
import { classifyPage, type PageLike } from '../src/browser/portal-state.js';
import { DEFAULT_SELECTORS, selectorsSchema } from '../src/browser/selectors.js';
import { VerizonPortalBillSource } from '../src/browser/verizon-portal.js';
import { FakeGmailReader, makeConfig, makeMessage } from './helpers/factories.js';

/** A page that exists only as a URL plus a set of selectors that "match". */
function fakePage(url: string, present: string[] = []): PageLike {
  return {
    url: () => url,
    locator: (selector: string) => ({ count: async () => (present.includes(selector) ? 1 : 0) }),
  };
}

const READY_URL = 'https://www.verizon.com/my-verizon/bill';

describe('portal state classification', () => {
  it('reports ready when signed in and unchallenged', async () => {
    expect(await classifyPage(fakePage(READY_URL), DEFAULT_SELECTORS)).toMatchObject({ state: 'ready' });
  });

  it('does NOT call the public marketing site "ready"', async () => {
    // Regression: absence of a login form was once treated as proof of a
    // session, so verizon.com's homepage classified as ready. It is not.
    const result = await classifyPage(fakePage('https://www.verizon.com/'), DEFAULT_SELECTORS);
    expect(result.state).toBe('unknown');
  });

  it('accepts positive proof of a session from a sign-out control', async () => {
    const result = await classifyPage(
      fakePage('https://secure.verizon.com/somewhere', ['a[href*="signout"]']),
      DEFAULT_SELECTORS,
    );
    expect(result).toMatchObject({ state: 'ready', evidence: 'matched a[href*="signout"]' });
  });

  it('detects a login wall from the URL', async () => {
    const result = await classifyPage(fakePage('https://login.verizon.com/signin'), DEFAULT_SELECTORS);
    expect(result.state).toBe('signed-out');
  });

  it('detects a login wall from a password field', async () => {
    const result = await classifyPage(fakePage(READY_URL, ['input[type="password"]']), DEFAULT_SELECTORS);
    expect(result).toMatchObject({ state: 'signed-out', evidence: 'matched input[type="password"]' });
  });

  it('detects a CAPTCHA and does not treat it as merely signed-out', async () => {
    const result = await classifyPage(fakePage(READY_URL, ['iframe[src*="recaptcha"]']), DEFAULT_SELECTORS);
    expect(result.state).toBe('challenge');
  });

  it('detects an MFA one-time-code prompt', async () => {
    const result = await classifyPage(fakePage(READY_URL, ['input[autocomplete="one-time-code"]']), DEFAULT_SELECTORS);
    expect(result.state).toBe('challenge');
  });

  it('treats a challenge as a challenge even when a password field is also present', async () => {
    // Order matters: "a human is needed" must win over "just log in again".
    const result = await classifyPage(
      fakePage('https://www.verizon.com/challenge', ['input[type="password"]']),
      DEFAULT_SELECTORS,
    );
    expect(result.state).toBe('challenge');
  });

  it('ignores a selector Playwright cannot parse instead of throwing', async () => {
    const page: PageLike = {
      url: () => READY_URL,
      locator: () => ({
        count: async () => {
          throw new Error('bad selector');
        },
      }),
    };
    expect(await classifyPage(page, DEFAULT_SELECTORS)).toMatchObject({ state: 'ready' });
  });
});

describe('selector configuration', () => {
  it('supplies working defaults', () => {
    expect(DEFAULT_SELECTORS.downloadTriggers.length).toBeGreaterThan(0);
    expect(DEFAULT_SELECTORS.challengeIndicators.length).toBeGreaterThan(0);
  });

  it('accepts an override file shape', () => {
    const parsed = selectorsSchema.parse({ downloadTriggers: ['a.my-bill-pdf'] });
    expect(parsed.downloadTriggers).toEqual(['a.my-bill-pdf']);
    // Unspecified groups still fall back to defaults.
    expect(parsed.challengeIndicators.length).toBeGreaterThan(0);
  });
});

describe('portal bill source', () => {
  const context = (config: ReturnType<typeof makeConfig>) => ({
    message: makeMessage(),
    reader: new FakeGmailReader([]),
    allowedDomains: config.verizonAllowedDomains,
    dryRun: true,
  });

  it('refuses to run unattended, and says how to proceed, without launching a browser', async () => {
    const config = makeConfig();

    const result = await new VerizonPortalBillSource(config).acquire(context(config));

    expect(result.status).toBe('needs_intervention');
    if (result.status === 'needs_intervention') {
      expect(result.instructions).toContain('--interactive');
      expect(result.instructions).toContain('--bill');
      expect(result.instructions).toContain('no credentials were used');
    }
  });

  it('checks the billing URL against the allowlist before opening anything', async () => {
    const config = makeConfig({ VERIZON_BILLING_URL: 'https://attacker.example/bill' });

    const result = await new VerizonPortalBillSource(config, true).acquire(context(config));

    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toMatch(/not in the configured allowlist/);
    }
  });

  it('refuses a plain-http billing URL', async () => {
    const config = makeConfig({ VERIZON_BILLING_URL: 'http://www.verizon.com/mybill/' });

    const result = await new VerizonPortalBillSource(config, true).acquire(context(config));

    expect(result.status).toBe('unavailable');
  });

  it('reports a GUI-less host as needing a human, without opening anything', async () => {
    const config = makeConfig({ BROWSER_ENABLED: 'false' });

    // Even in interactive mode: no display means no sign-in is possible here.
    const result = await new VerizonPortalBillSource(config, true).acquire(context(config));

    expect(result.status).toBe('needs_intervention');
    if (result.status === 'needs_intervention') {
      expect(result.reason).toContain('BROWSER_ENABLED=false');
      expect(result.instructions).toContain('--interactive');
    }
  });

  it('has no way to accept a password', () => {
    // Automated sign-in was removed; assert the capability is genuinely gone
    // rather than merely unused.
    const source = new VerizonPortalBillSource(makeConfig(), true);
    expect(Object.keys(source)).not.toContain('credentials');
    expect(JSON.stringify(makeConfig().verizon)).not.toContain('password');
  });
});

describe('browser crash handling', () => {
  it('recognises browser-death errors and not ordinary page errors', async () => {
    const { isBrowserCrash } = await import('../src/browser/driver.js');

    expect(isBrowserCrash(new Error('Target page, context or browser has been closed'))).toBe(true);
    expect(isBrowserCrash(new Error('Browser closed unexpectedly'))).toBe(true);
    expect(isBrowserCrash(new Error('page crashed'))).toBe(true);

    // A missing selector is a page problem, not a crash — it must not be
    // reported as one, or the operator gets sent to clear a healthy profile.
    expect(isBrowserCrash(new Error('locator.click: Timeout 10000ms exceeded'))).toBe(false);
    expect(isBrowserCrash(new Error('no username field found on the sign-in page'))).toBe(false);
  });
});
