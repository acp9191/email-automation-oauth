import { getWorkflow } from '../workflows/registry.js';
import { GmailPollingSource } from '../triggers/gmail-poll.js';
import { buildContext } from './context.js';
import { banner, printWorkflowResult } from './output.js';

/* eslint-disable no-console */

const WORKFLOW_ID = 'verizon-bill-reimbursement';

export interface RunVerizonOptions {
  messageId?: string;
  force?: boolean;
  billPath?: string;
  /** Open a visible browser and wait for you to sign in, then finish the run. */
  interactive?: boolean;
}

/**
 * Manual trigger for the Verizon workflow.
 * With no `--message`, it polls Gmail and runs the most recent match.
 */
export async function runVerizonCommand(options: RunVerizonOptions): Promise<number> {
  const context = buildContext();
  try {
    const { config, reader, runner } = context;
    banner(config);

    const workflow = getWorkflow(config, WORKFLOW_ID, { interactive: options.interactive });
    if (options.interactive) {
      console.log('  Attended mode: a browser will open. Sign in and complete any MFA.');
      console.log('  Everything after that — download, verify, name, send, record — is automatic.\n');
    }

    let message;
    if (options.messageId) {
      message = await reader.getMessage(options.messageId);
    } else {
      const source = new GmailPollingSource(config, reader, workflow);
      const triggered = await source.poll();
      if (triggered.length === 0) {
        console.log('  No matching Verizon bill notification found in the lookback window.');
        console.log('  Try `npm run scan -- --explain` to see why recent messages did not match.\n');
        return 0;
      }
      // Most recent match wins.
      triggered.sort((a, b) => b.message.internalDate.getTime() - a.message.internalDate.getTime());
      message = triggered[0]!.message;
      console.log(`  Selected message ${message.id} (${message.internalDate.toISOString().slice(0, 10)})`);
    }

    const result = await runner.run(workflow, {
      source: 'manual',
      message,
      force: options.force ?? false,
      billPath: options.billPath,
    });

    printWorkflowResult(result);
    return result.status === 'failed' ? 1 : 0;
  } finally {
    context.close();
  }
}
