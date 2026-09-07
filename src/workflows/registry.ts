import type { Config } from '../config/index.js';
import { getRule, loadRules } from '../detection/rules.js';
import { VerizonBillReimbursementWorkflow } from './verizon-bill.js';
import { AttachmentBillSource } from '../bill/source.js';
import { VerizonPortalBillSource } from '../browser/verizon-portal.js';
import type { Workflow } from './types.js';

/**
 * The workflow registry.
 *
 * Adding an automation means writing one class and adding one line here — the
 * runner, CLI, idempotency ledger, dry-run handling and notifications are all
 * shared and need no changes.
 */
export interface RegistryOptions {
  /** Open a visible browser and wait for a human sign-in. */
  interactive?: boolean;
}

export function buildRegistry(config: Config, options: RegistryOptions = {}): Workflow[] {
  const rules = loadRules(config);
  const rule = getRule(rules, 'verizon-bill-notification');
  // Attended runs swap in a portal source that will open a browser and wait.
  const sources = options.interactive
    ? [new AttachmentBillSource(), new VerizonPortalBillSource(config, true)]
    : undefined;
  return [new VerizonBillReimbursementWorkflow(config, rule, sources)];
}

export class UnknownWorkflowError extends Error {}

export function getWorkflow(config: Config, id: string, options: RegistryOptions = {}): Workflow {
  const workflow = buildRegistry(config, options).find((candidate) => candidate.id === id);
  if (!workflow) {
    const known = buildRegistry(config).map((candidate) => candidate.id).join(', ');
    throw new UnknownWorkflowError(`Unknown workflow "${id}". Known workflows: ${known}`);
  }
  return workflow;
}
