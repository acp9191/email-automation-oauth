import type { NormalizedMessage } from '../gmail/types.js';
import { evaluateRule, type MatchResult } from './match.js';
import { VERIZON_BILL_RULE, type DetectionRule } from './rules.js';

/**
 * Is this message a Verizon bill-ready notification?
 *
 * Purely deterministic: sender domain, subject pattern, exclusion patterns,
 * message age and keyword count. Callers wanting the "why" use `explain`.
 */
export function isVerizonBillNotification(
  message: NormalizedMessage,
  rule: DetectionRule = VERIZON_BILL_RULE,
  now = new Date(),
): boolean {
  return evaluateRule(message, rule, now).matched;
}

export function explainVerizonDetection(
  message: NormalizedMessage,
  rule: DetectionRule = VERIZON_BILL_RULE,
  now = new Date(),
): MatchResult {
  return evaluateRule(message, rule, now);
}
