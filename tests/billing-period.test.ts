import { describe, expect, it } from 'vitest';
import { billingPeriodSlug, extractBillingPeriod } from '../src/detection/billing-period.js';
import { makeMessage } from './helpers/factories.js';

const NOW = new Date('2026-08-25T00:00:00Z');

describe('billing period extraction', () => {
  it('prefers an explicit range in the subject and uses the closing month', () => {
    const message = makeMessage({ subject: 'Your Verizon bill for Jul 20 - Aug 19, 2026 is ready' });
    const period = extractBillingPeriod(message, NOW);
    expect(period).toMatchObject({ period: '2026-08', label: 'August 2026', source: 'subject-range', confidence: 'high' });
  });

  it('reads a plain month and year from the subject', () => {
    const message = makeMessage({ subject: 'Your Verizon bill for August 2026 is ready' });
    expect(extractBillingPeriod(message, NOW)).toMatchObject({ period: '2026-08', source: 'subject-month' });
  });

  it('falls back to a range in the body', () => {
    const period = extractBillingPeriod(makeMessage(), NOW);
    expect(period).toMatchObject({ period: '2026-08', label: 'August 2026', source: 'body-range', confidence: 'high' });
  });

  it('reads a numeric month/year from the body', () => {
    const message = makeMessage({ bodyText: 'Your account statement for 07/2026 is available.' });
    expect(extractBillingPeriod(message, NOW)).toMatchObject({ period: '2026-07', confidence: 'medium' });
  });

  it('falls back to the message date and marks it low confidence', () => {
    const message = makeMessage({ subject: 'Your Verizon bill is ready', bodyText: 'Sign in to view your bill.' });
    const period = extractBillingPeriod(message, NOW);
    expect(period).toMatchObject({ period: '2026-08', source: 'message-date', confidence: 'low' });
  });

  it('ignores implausible years rather than trusting them', () => {
    const message = makeMessage({ subject: 'Your Verizon bill for August 1998', bodyText: 'Sign in to view.' });
    expect(extractBillingPeriod(message, NOW).source).toBe('message-date');
  });

  it('produces a filename-safe slug', () => {
    expect(billingPeriodSlug({ period: '2026-08', label: 'August 2026', source: 'subject-month', confidence: 'high' }))
      .toBe('August_2026');
  });
});
