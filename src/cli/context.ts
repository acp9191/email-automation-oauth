import { getConfig, type Config } from '../config/index.js';
import { GmailReadClient, GmailSendClient } from '../gmail/client.js';
import { hasCredentials } from '../gmail/auth.js';
import { GuardedMailer } from '../email/sender.js';
import { buildNotifier } from '../notify/index.js';
import { openDatabase, type Database } from '../storage/db.js';
import { Repository } from '../storage/repository.js';
import { WorkflowRunner } from '../workflows/runner.js';
import { getLogger } from '../logging/index.js';
import type { GmailSender } from '../gmail/types.js';

/**
 * Shared CLI wiring.
 *
 * Note what happens in dry-run mode: no send-capable credential is loaded at
 * all, so a dry run is incapable of sending mail even if something downstream
 * ignored the flag.
 */
export interface CliContext {
  config: Config;
  db: Database;
  repository: Repository;
  reader: GmailReadClient;
  runner: WorkflowRunner;
  close(): void;
}

export function buildContext(): CliContext {
  const config = getConfig();
  const logger = getLogger();
  const db = openDatabase(config.dbPath);
  const repository = new Repository(db);
  const reader = new GmailReadClient(config);

  let sender: GmailSender | undefined;
  if (!config.dryRun) {
    if (!hasCredentials(config, 'send')) {
      throw new Error(
        'DRY_RUN is false but the "send" credential profile is not authorized. Run: npm run auth -- --profile send',
      );
    }
    sender = new GmailSendClient(config);
  }

  const mailer = new GuardedMailer(
    config.workEmail ? [config.workEmail] : [],
    config.dryRun,
    sender,
  );
  const notifier = buildNotifier(config, logger, sender);
  const runner = new WorkflowRunner(config, repository, reader, mailer, notifier);

  return { config, db, repository, reader, runner, close: () => db.close() };
}
