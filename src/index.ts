import { parseArgs } from 'node:util';
import { authCommand } from './cli/auth.js';
import { gmailTestCommand } from './cli/gmail-test.js';
import { runVerizonCommand } from './cli/run-verizon.js';
import { scanCommand } from './cli/scan.js';
import { statusCommand } from './cli/status.js';
import { watchCommand } from './cli/watch.js';
import { healthCommand } from './cli/health.js';
import { inspectCommand } from './cli/inspect.js';
import { verizonProbeCommand } from './cli/verizon-probe.js';
import { printError } from './cli/output.js';

/* eslint-disable no-console */

const USAGE = `
  Personal email automation

  Commands
    auth [--profile read|send|all]   Authorize Gmail (two least-privilege consents)
    gmail:test                       Verify authentication, print account metadata only
    scan [--explain]                 Show which recent messages match; executes nothing
    run-verizon [options]            Run the Verizon bill reimbursement workflow
      --message <id>                 Use a specific Gmail message instead of polling
      --force                        Re-run a message that already completed
      --bill <path>                  Use a bill PDF you downloaded manually
      --interactive                  Open a browser, wait for you to sign in, then finish
    status [--limit <n>]             Config, credentials, workflows, and recent runs
    watch [--interval <s>] [--once]  Poll Gmail and run matching workflows (--once: one poll, then exit)
    health                           Local readiness check (used by the container healthcheck)
    inspect --message <id>           Read-only: structure, attachments and links of one message
    verizon:probe [--interactive]    Read-only: what the billing page offers (for selectors)

  Safety
    DRY_RUN=true (the default) reads Gmail and obtains the bill but sends nothing.
`;

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }

  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      profile: { type: 'string' },
      message: { type: 'string' },
      bill: { type: 'string' },
      limit: { type: 'string' },
      interval: { type: 'string' },
      once: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      explain: { type: 'boolean', default: false },
      interactive: { type: 'boolean', default: false },
    },
  });

  switch (command) {
    case 'auth':
      await authCommand(values.profile as string | undefined);
      return 0;

    case 'gmail:test':
      await gmailTestCommand();
      return 0;

    case 'scan':
      await scanCommand({
        workflowId: 'verizon-bill-reimbursement',
        explain: Boolean(values.explain),
      });
      return 0;

    case 'run-verizon':
      return runVerizonCommand({
        messageId: values.message as string | undefined,
        force: Boolean(values.force),
        billPath: values.bill as string | undefined,
        interactive: Boolean(values.interactive),
      });

    case 'status':
      await statusCommand(Number(values.limit ?? 20));
      return 0;

    case 'watch':
      return watchCommand({
        ...(values.interval ? { intervalSeconds: Number(values.interval) } : {}),
        once: Boolean(values.once),
      });

    case 'health':
      return healthCommand();

    case 'verizon:probe':
      return verizonProbeCommand(Boolean(values.interactive));

    case 'inspect': {
      const id = values.message as string | undefined;
      if (!id) throw new Error('inspect requires --message <gmail-message-id>');
      return inspectCommand(id);
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    printError(error);
    process.exitCode = 1;
  });
