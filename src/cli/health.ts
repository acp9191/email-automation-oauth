import { getConfig } from '../config/index.js';
import { hasCredentials } from '../gmail/auth.js';
import { openDatabase } from '../storage/db.js';

/* eslint-disable no-console */

/**
 * Container health check. Local only — it opens the database and confirms the
 * credentials the current mode needs, without calling the Gmail API.
 */
export async function healthCommand(): Promise<number> {
  const config = getConfig();
  const problems: string[] = [];

  try {
    openDatabase(config.dbPath).close();
  } catch (error) {
    problems.push(`database not usable: ${(error as Error).message}`);
  }

  if (!hasCredentials(config, 'read')) problems.push('gmail "read" profile is not authorized');
  if (!config.dryRun && !hasCredentials(config, 'send')) {
    problems.push('DRY_RUN is false but the gmail "send" profile is not authorized');
  }
  if (!config.workEmail) problems.push('WORK_EMAIL is not set');

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  unhealthy: ${problem}`);
    return 1;
  }

  console.log(`  healthy (dry_run=${config.dryRun})`);
  return 0;
}
