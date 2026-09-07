import { describe, expect, it } from 'vitest';
import { explainVerizonDetection, isVerizonBillNotification } from '../src/detection/verizon.js';
import { VERIZON_BILL_RULE } from '../src/detection/rules.js';
import { matchesDomain } from '../src/detection/match.js';
import { makeMessage } from './helpers/factories.js';

const NOW = new Date('2026-08-25T00:00:00Z');

describe('Verizon bill detection', () => {
  it('accepts a genuine Verizon bill notification', () => {
    expect(isVerizonBillNotification(makeMessage(), VERIZON_BILL_RULE, NOW)).toBe(true);
  });

  it('accepts the real notification Verizon actually sends', () => {
    // Observed 2026-08-12 on the live mailbox. Pinned so a rule change that
    // breaks the one subject line that matters fails the suite.
    const message = makeMessage({
      from: 'verizon-notification@ecrm-mail.verizon.com',
      subject: 'Your bill is now available online',
    });
    expect(isVerizonBillNotification(message, VERIZON_BILL_RULE, NOW)).toBe(true);
  });

  it('accepts mail from a Verizon subdomain', () => {
    const message = makeMessage({ from: 'no-reply@ecrmemail.verizonwireless.com' });
    expect(isVerizonBillNotification(message, VERIZON_BILL_RULE, NOW)).toBe(true);
  });

  it('accepts an HTML-only notification', () => {
    const message = makeMessage({
      bodyText: '',
      bodyHtml: '<html><body><p>Your Verizon bill is ready.</p><p>Account ending 4417</p></body></html>',
    });
    expect(isVerizonBillNotification(message, VERIZON_BILL_RULE, NOW)).toBe(true);
  });
});

describe('non-Verizon rejection', () => {
  it('rejects an unrelated sender using the same subject', () => {
    const message = makeMessage({ from: 'billing@totally-not-verizon.com' });
    const verdict = explainVerizonDetection(message, VERIZON_BILL_RULE, NOW);
    expect(verdict.matched).toBe(false);
    expect(verdict.failures.join(' ')).toMatch(/sender domain/);
  });

  it('rejects the real subject line when the sender is not Verizon', () => {
    const message = makeMessage({
      from: 'verizon-notification@ecrm-mail.verizon.com.attacker.example',
      subject: 'Your bill is now available online',
    });
    expect(isVerizonBillNotification(message, VERIZON_BILL_RULE, NOW)).toBe(false);
  });

  it('rejects a look-alike domain that merely contains the brand name', () => {
    const message = makeMessage({ from: 'billing@verizon.com.attacker.example' });
    expect(isVerizonBillNotification(message, VERIZON_BILL_RULE, NOW)).toBe(false);
  });

  it('rejects a suffix look-alike such as notverizon.com', () => {
    expect(matchesDomain('notverizon.com', ['verizon.com'])).toBe(false);
    expect(matchesDomain('mail.verizon.com', ['verizon.com'])).toBe(true);
  });

  it('rejects Verizon marketing mail via the exclusion patterns', () => {
    const message = makeMessage({ subject: 'Your Verizon bill — upgrade and save $20' });
    const verdict = explainVerizonDetection(message, VERIZON_BILL_RULE, NOW);
    expect(verdict.matched).toBe(false);
    expect(verdict.failures.join(' ')).toMatch(/exclusion/);
  });

  it('rejects an off-topic Verizon email', () => {
    const message = makeMessage({
      subject: 'Verizon network maintenance notice',
      bodyText: 'We are performing maintenance in your area.',
    });
    expect(isVerizonBillNotification(message, VERIZON_BILL_RULE, NOW)).toBe(false);
  });

  it('rejects a message older than the rule allows', () => {
    const message = makeMessage({ internalDate: new Date('2026-01-01T00:00:00Z') });
    const verdict = explainVerizonDetection(message, VERIZON_BILL_RULE, NOW);
    expect(verdict.matched).toBe(false);
    expect(verdict.failures.join(' ')).toMatch(/days old/);
  });

  it('rejects a message with no usable date', () => {
    const message = makeMessage({ internalDate: new Date(0) });
    expect(isVerizonBillNotification(message, VERIZON_BILL_RULE, NOW)).toBe(false);
  });

  it('rejects a matching subject with too few supporting keywords', () => {
    const message = makeMessage({ subject: 'Your Verizon bill', bodyText: 'hi' });
    const verdict = explainVerizonDetection(message, VERIZON_BILL_RULE, NOW);
    expect(verdict.matched).toBe(false);
    expect(verdict.failures.join(' ')).toMatch(/keywords/);
  });
});
