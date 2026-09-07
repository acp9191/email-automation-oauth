import { searchableText } from '../gmail/parse.js';
import type { NormalizedMessage } from '../gmail/types.js';
import { MAX_SCAN_CHARS } from './match.js';

/**
 * Deterministic billing-period extraction.
 *
 * Order of preference: an explicit date range, then an explicit month, then the
 * message's own date. The `confidence` field is what tells the workflow whether
 * a human (or, later, the agent layer) should look at an ambiguous case.
 */

export type PeriodSource =
  | 'subject-range'
  | 'subject-month'
  | 'body-range'
  | 'body-month'
  | 'message-date';

export interface BillingPeriod {
  /** Canonical `YYYY-MM`, used as the idempotency/label key. */
  period: string;
  /** Human label, e.g. `August 2026`. */
  label: string;
  source: PeriodSource;
  confidence: 'high' | 'medium' | 'low';
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const MONTH_NAMES = MONTHS.map((month) => month[0]!.toUpperCase() + month.slice(1));

const MONTH_ALT = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';

function monthIndex(token: string): number {
  const lower = token.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((month) => month.startsWith(lower));
}

function plausibleYear(year: number, now: Date): boolean {
  const current = now.getUTCFullYear();
  return year >= current - 5 && year <= current + 1;
}

function build(monthIdx: number, year: number, source: PeriodSource, confidence: BillingPeriod['confidence']): BillingPeriod {
  return {
    period: `${year}-${String(monthIdx + 1).padStart(2, '0')}`,
    label: `${MONTH_NAMES[monthIdx]} ${year}`,
    source,
    confidence,
  };
}

/** `Jul 20 - Aug 19, 2026` → August 2026 (the month the period closes in). */
function findRange(text: string, now: Date): { monthIdx: number; year: number } | null {
  const pattern = new RegExp(
    `${MONTH_ALT}\\.?\\s+\\d{1,2}\\s*(?:-|–|—|to|through)\\s*${MONTH_ALT}\\.?\\s+\\d{1,2}(?:\\s*,)?\\s*(\\d{4})`,
    'i',
  );
  const match = pattern.exec(text);
  if (!match) return null;
  const endMonth = monthIndex(match[2] ?? '');
  const year = Number(match[3]);
  if (endMonth < 0 || !plausibleYear(year, now)) return null;
  return { monthIdx: endMonth, year };
}

/** `August 2026` or `08/2026`. */
function findMonth(text: string, now: Date): { monthIdx: number; year: number } | null {
  const named = new RegExp(`${MONTH_ALT}\\.?\\s+(\\d{4})`, 'i').exec(text);
  if (named) {
    const idx = monthIndex(named[1] ?? '');
    const year = Number(named[2]);
    if (idx >= 0 && plausibleYear(year, now)) return { monthIdx: idx, year };
  }

  const numeric = /\b(0?[1-9]|1[0-2])[/-](\d{4})\b/.exec(text);
  if (numeric) {
    const idx = Number(numeric[1]) - 1;
    const year = Number(numeric[2]);
    if (idx >= 0 && idx < 12 && plausibleYear(year, now)) return { monthIdx: idx, year };
  }

  return null;
}

export function extractBillingPeriod(message: NormalizedMessage, now = new Date()): BillingPeriod {
  const subject = message.subject.slice(0, 1000);
  const body = searchableText(message).slice(0, MAX_SCAN_CHARS);

  const subjectRange = findRange(subject, now);
  if (subjectRange) return build(subjectRange.monthIdx, subjectRange.year, 'subject-range', 'high');

  const subjectMonth = findMonth(subject, now);
  if (subjectMonth) return build(subjectMonth.monthIdx, subjectMonth.year, 'subject-month', 'high');

  const bodyRange = findRange(body, now);
  if (bodyRange) return build(bodyRange.monthIdx, bodyRange.year, 'body-range', 'high');

  const bodyMonth = findMonth(body, now);
  if (bodyMonth) return build(bodyMonth.monthIdx, bodyMonth.year, 'body-month', 'medium');

  // Fall back to when the notification arrived. Low confidence on purpose: the
  // workflow surfaces this so a wrong month is visible rather than silent.
  const fallback = message.internalDate.getTime() > 0 ? message.internalDate : now;
  return build(fallback.getUTCMonth(), fallback.getUTCFullYear(), 'message-date', 'low');
}

/** `August 2026` → `August_2026`, safe for a filename. */
export function billingPeriodSlug(period: BillingPeriod): string {
  return period.label.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
}
