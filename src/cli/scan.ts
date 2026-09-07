import { explainVerizonDetection } from '../detection/verizon.js';
import { getRule, loadRules } from '../detection/rules.js';
import { buildContext } from './context.js';

/* eslint-disable no-console */

/**
 * Read-only reconnaissance: shows which recent messages the detector matches
 * and, for near-misses, exactly which rule failed. Runs no workflow and sends
 * nothing, whatever DRY_RUN is set to.
 */
export async function scanCommand(options: { workflowId: string; explain: boolean }): Promise<void> {
  const context = buildContext();
  try {
    const { config, reader } = context;
    const rule = getRule(loadRules(config), 'verizon-bill-notification');
    const query = `${rule.gmailQuery} newer_than:${config.gmail.lookbackDays}d`;

    console.log(`\n  Gmail query: ${query}`);
    const ids = await reader.search(query, config.gmail.maxResults);
    console.log(`  Candidates returned by Gmail: ${ids.length}\n`);

    let matched = 0;
    for (const id of ids) {
      const message = await reader.getMessage(id);
      const verdict = explainVerizonDetection(message, rule);
      const processed = context.repository.find(id, options.workflowId);

      const state = verdict.matched
        ? processed
          ? `MATCH (already ${processed.status})`
          : 'MATCH (unprocessed)'
        : 'no match';
      if (verdict.matched) matched += 1;

      console.log(`  ${id}  ${message.internalDate.toISOString().slice(0, 10)}  ${state}`);
      console.log(`      from:    ${message.from?.email ?? '(none)'}`);
      console.log(`      subject: ${message.subject.slice(0, 100)}`);
      if (options.explain) {
        for (const reason of verdict.reasons) console.log(`      + ${reason}`);
        for (const failure of verdict.failures) console.log(`      - ${failure}`);
      }
      console.log('');
    }

    console.log(`  ${matched} of ${ids.length} message(s) matched the Verizon bill rule.`);
    console.log('  Nothing was executed. Use `npm run run-verizon` to process one.\n');
  } finally {
    context.close();
  }
}
