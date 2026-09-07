import { domainOf, searchableText } from '../gmail/parse.js';
import type { NormalizedMessage } from '../gmail/types.js';
import type { DetectionRule } from './rules.js';

/**
 * Deterministic rule matching. No LLM is involved in deciding whether a message
 * is a bill notification — an email cannot talk its way into being processed.
 */

/** Body text is truncated before any regex runs, so a huge email cannot stall us. */
export const MAX_SCAN_CHARS = 100_000;

export interface MatchResult {
  matched: boolean;
  ruleId: string;
  reasons: string[];
  failures: string[];
}

export function matchesDomain(domain: string | null, allowed: string[]): boolean {
  if (!domain) return false;
  const normalized = domain.toLowerCase();
  return allowed.some((entry) => {
    const suffix = entry.toLowerCase();
    return normalized === suffix || normalized.endsWith(`.${suffix}`);
  });
}

function anyPatternMatches(patterns: string[], text: string): string | null {
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, 'i').test(text)) return pattern;
    } catch {
      // A malformed rule pattern is ignored rather than crashing detection.
    }
  }
  return null;
}

export function evaluateRule(message: NormalizedMessage, rule: DetectionRule, now = new Date()): MatchResult {
  const reasons: string[] = [];
  const failures: string[] = [];

  const senderDomain = domainOf(message.from);
  if (matchesDomain(senderDomain, rule.senderDomains)) {
    reasons.push(`sender domain ${senderDomain} is allowed`);
  } else {
    failures.push(`sender domain ${senderDomain ?? '(none)'} is not in [${rule.senderDomains.join(', ')}]`);
  }

  const subject = message.subject.slice(0, 1000);
  const subjectHit = anyPatternMatches(rule.subjectPatterns, subject);
  if (subjectHit) reasons.push(`subject matched /${subjectHit}/i`);
  else failures.push('subject matched no configured pattern');

  const negativeHit = anyPatternMatches(rule.negativeSubjectPatterns, subject);
  if (negativeHit) failures.push(`subject matched exclusion /${negativeHit}/i`);

  const ageDays = (now.getTime() - message.internalDate.getTime()) / 86_400_000;
  if (message.internalDate.getTime() === 0) {
    failures.push('message has no usable date');
  } else if (ageDays > rule.maxAgeDays) {
    failures.push(`message is ${Math.round(ageDays)} days old (max ${rule.maxAgeDays})`);
  } else {
    reasons.push(`message is ${Math.max(0, Math.round(ageDays))} days old`);
  }

  const haystack = `${subject}\n${searchableText(message).slice(0, MAX_SCAN_CHARS)}`.toLowerCase();
  const hits = rule.keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
  if (hits.length >= rule.minKeywordHits) {
    reasons.push(`matched ${hits.length} keyword(s): ${hits.join(', ')}`);
  } else {
    failures.push(`only ${hits.length} of ${rule.minKeywordHits} required keywords matched`);
  }

  return { matched: failures.length === 0, ruleId: rule.id, reasons, failures };
}
