import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from '../config/index.js';

/**
 * Detection rules live in data, not scattered through the code.
 *
 * Defaults are below; they can be overridden without a code change by dropping
 * a `detection-rules.json` into DATA_DIR (same shape, validated on load).
 */

export const detectionRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Sender domain suffixes. `verizon.com` also matches `mail.verizon.com`. */
  senderDomains: z.array(z.string().min(1)).min(1),
  /** Case-insensitive regular expressions; at least one must match the subject. */
  subjectPatterns: z.array(z.string().min(1)).min(1),
  /** Subject patterns that immediately disqualify a message (promos, etc.). */
  negativeSubjectPatterns: z.array(z.string()).default([]),
  /** Body/subject keywords; `minKeywordHits` distinct hits are required. */
  keywords: z.array(z.string().min(1)).default([]),
  minKeywordHits: z.number().int().min(0).default(1),
  /** Messages older than this are ignored even if they match. */
  maxAgeDays: z.number().int().min(1).max(365).default(45),
  /** Server-side Gmail prefilter, so we never download the whole mailbox. */
  gmailQuery: z.string().min(1),
});

export type DetectionRule = z.infer<typeof detectionRuleSchema>;

export const VERIZON_BILL_RULE: DetectionRule = {
  id: 'verizon-bill-notification',
  name: 'Verizon bill ready notification',
  senderDomains: ['verizon.com', 'verizonwireless.com', 'verizon.net'],
  subjectPatterns: [
    // Verizon's actual wording as of 2026: "Your bill is now available online".
    // The filler between "bill" and the status word is why this is loose — the
    // sender-domain check is the real gate, not the subject.
    '\\byour\\b.{0,25}\\bbill\\b.{0,30}\\b(ready|available|posted|here)\\b',
    '\\byour .{0,20}(verizon|fios).{0,20}bill\\b',
    '\\bverizon\\b.{0,40}\\bbill\\b.{0,20}\\b(is )?(ready|available|here)\\b',
    '\\bbill(ing)? statement\\b',
  ],
  negativeSubjectPatterns: [
    '\\bpast due\\b',
    '\\boffer\\b',
    '\\bsave \\$',
    '\\bupgrade\\b',
    '\\bsurvey\\b',
  ],
  keywords: ['bill', 'statement', 'amount due', 'billing period', 'account', 'fios', 'internet'],
  minKeywordHits: 2,
  maxAgeDays: 45,
  // Gmail's own search does the first, cheapest pass.
  gmailQuery: 'from:(verizon.com OR verizonwireless.com OR verizon.net) (bill OR statement)',
};

export const DEFAULT_RULES: DetectionRule[] = [VERIZON_BILL_RULE];

const overrideSchema = z.object({ rules: z.array(detectionRuleSchema).min(1) });

export class RuleError extends Error {}

/** Loads rules, preferring `<DATA_DIR>/detection-rules.json` when present. */
export function loadRules(config: Config): DetectionRule[] {
  const file = path.join(config.dataDir, 'detection-rules.json');
  if (!fs.existsSync(file)) return DEFAULT_RULES;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new RuleError(`Could not parse ${file}: ${(error as Error).message}`);
  }

  const result = overrideSchema.safeParse(parsed);
  if (!result.success) {
    throw new RuleError(
      `Invalid detection rules in ${file}:\n${result.error.issues
        .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  return result.data.rules;
}

export function getRule(rules: DetectionRule[], id: string): DetectionRule {
  const rule = rules.find((candidate) => candidate.id === id);
  if (!rule) throw new RuleError(`No detection rule with id "${id}"`);
  return rule;
}
