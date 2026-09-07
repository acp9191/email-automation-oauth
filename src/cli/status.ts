import { describeCredentials } from '../gmail/auth.js';
import { buildRegistry } from '../workflows/registry.js';
import { buildContext } from './context.js';

/* eslint-disable no-console */

export async function statusCommand(limit: number): Promise<void> {
  const context = buildContext();
  try {
    const { config, repository } = context;

    console.log('\n  Configuration');
    console.log(`    DRY_RUN:        ${config.dryRun}`);
    console.log(`    WORK_EMAIL:     ${config.workEmail || '(not set)'}`);
    console.log(`    NOTIFY_EMAIL:   ${config.notifyEmail || '(log only)'}`);
    console.log(`    data dir:       ${config.dataDir}`);
    console.log(`    allowed hosts:  ${config.verizonAllowedDomains.join(', ')}`);

    console.log('\n  Credentials');
    for (const entry of describeCredentials(config)) {
      console.log(`    ${entry.profile.padEnd(5)} ${entry.authorized ? 'authorized' : 'NOT authorized'}  ${entry.scopes.join(' ')}`);
    }

    console.log('\n  Workflows');
    for (const workflow of buildRegistry(config)) {
      console.log(`    ${workflow.id}`);
      console.log(`      send to:  ${workflow.capabilities.allowedRecipients.join(', ') || '(none configured)'}`);
      console.log(`      network:  ${workflow.capabilities.networkDomains.join(', ') || '(none)'}`);
    }

    const processed = repository.recentProcessed(limit);
    console.log(`\n  Processed messages (${processed.length})`);
    if (processed.length === 0) console.log('    (none yet)');
    for (const row of processed) {
      console.log(
        `    ${row.updatedAt.slice(0, 19)}  ${row.status.padEnd(18)} ${row.billingPeriod ?? '-'}  ${row.gmailMessageId}` +
          `${row.dryRun ? '  [dry-run]' : ''}`,
      );
      if (row.error) console.log(`        error: ${row.error.slice(0, 160)}`);
    }

    const runs = repository.recentRuns(limit);
    console.log(`\n  Recent runs (${runs.length})`);
    if (runs.length === 0) console.log('    (none yet)');
    for (const run of runs) {
      console.log(
        `    #${String(run.id).padEnd(4)} ${run.startedAt.slice(0, 19)}  ${run.status.padEnd(18)} ` +
          `${run.workflowId}  via ${run.triggerSource}${run.stage ? `  @${run.stage}` : ''}`,
      );
    }
    console.log('');
  } finally {
    context.close();
  }
}
