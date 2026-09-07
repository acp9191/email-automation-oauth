import type { WorkflowResult } from '../workflows/types.js';

/* eslint-disable no-console */

const BAR = '─'.repeat(64);

export function banner(config: { dryRun: boolean }): void {
  if (config.dryRun) {
    console.log('\n  DRY RUN — Gmail will be read, but no email will be sent.\n');
  } else {
    console.log(`\n${BAR}\n  LIVE MODE — DRY_RUN is false. Email WILL be sent.\n${BAR}\n`);
  }
}

/** Renders the dry-run / live summary described in the plan. */
export function printWorkflowResult(result: WorkflowResult): void {
  const details = result.details as Record<string, unknown>;
  const label = details.billingPeriodLabel
    ? String(details.billingPeriodLabel)
    : details.billingPeriod
      ? String(details.billingPeriod)
      : null;

  console.log('');
  switch (result.status) {
    case 'success': {
      const dry = details.sent === false;
      if (label) console.log(`  Detected Verizon bill: ${label}`);
      if (details.filename) console.log(`  Downloaded:            ${details.filename}`);
      console.log(`  ${dry ? 'Would send to:        ' : 'Sent to:              '} ${String(details.recipient ?? '')}`);
      if (details.filename) {
        console.log(`  ${dry ? 'Would attach:         ' : 'Attached:             '} ${String(details.filename)}`);
      }
      if (details.subject) console.log(`  Subject:               ${String(details.subject)}`);
      if (details.outgoingMessageId) console.log(`  Outgoing message id:   ${String(details.outgoingMessageId)}`);
      if (details.billingPeriodConfidence === 'low') {
        console.log('\n  NOTE: the billing period was inferred from the email date, not stated in it.');
      }
      break;
    }
    case 'skipped':
      console.log(`  Skipped: ${result.summary}`);
      if (details.hint) console.log(`  Hint:    ${String(details.hint)}`);
      break;
    case 'needs_intervention':
      console.log(`  MANUAL INTERVENTION NEEDED (stage: ${result.stage})`);
      console.log(`  ${result.summary}`);
      if (result.instructions) console.log(`\n${result.instructions.replace(/^/gm, '  ')}`);
      break;
    case 'failed':
      console.log(`  FAILED at stage "${result.stage}"`);
      console.log(`  ${result.summary}`);
      break;
  }
  console.log('');
}

export function printError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n  Error: ${message}\n`);
}
