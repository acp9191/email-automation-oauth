import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import type { GuardedMailer } from '../email/sender.js';
import type { GmailReader, NormalizedMessage } from '../gmail/types.js';
import type { Repository } from '../storage/repository.js';

/**
 * The generic workflow contract.
 *
 * A workflow declares up front what it is allowed to touch (`capabilities`),
 * decides for itself whether a message is its business (`matches`), and does
 * its work through the context it is handed — it never constructs its own
 * Gmail client or mailer, so its permissions cannot exceed its declaration.
 */

/** The engine does not care which of these fired; workflows behave identically. */
export type TriggerSource = 'manual' | 'gmail-poll' | 'gmail-push' | 'schedule';

export interface WorkflowTrigger {
  source: TriggerSource;
  /** Present whenever the trigger originated from a specific email. */
  message?: NormalizedMessage;
  /** Re-run a message that already completed successfully. Off by default. */
  force?: boolean;
  /** Operator-supplied bill PDF, used to finish a run that needed intervention. */
  billPath?: string;
}

export interface WorkflowCapabilities {
  /** Read Gmail messages and attachments. */
  gmailRead: boolean;
  /** Send mail — only ever to `allowedRecipients`. */
  gmailSend: boolean;
  /** Hosts this workflow may contact. Empty means no outbound network. */
  networkDomains: string[];
  /** Addresses this workflow may send to. Empty means it cannot send. */
  allowedRecipients: string[];
  /** Directories it may write artifacts into. */
  writableDirs: string[];
}

export interface WorkflowContext {
  config: Config;
  repository: Repository;
  reader: GmailReader;
  mailer: GuardedMailer;
  logger: Logger;
  runId: number;
  dryRun: boolean;
  now: Date;
}

export type WorkflowStatus = 'success' | 'skipped' | 'failed' | 'needs_intervention';

/** Named stages, so a failure notification can say where it stopped. */
export type WorkflowStage =
  | 'detect'
  | 'idempotency'
  | 'billing-period'
  | 'acquire-bill'
  | 'store-artifact'
  | 'send'
  | 'record';

export interface WorkflowResult {
  status: WorkflowStatus;
  stage: WorkflowStage;
  /** One-line human summary, safe to log and to put in a notification. */
  summary: string;
  details: Record<string, unknown>;
  error?: string;
  /** Lines shown verbatim to the operator when a human is needed. */
  instructions?: string;
}

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: WorkflowCapabilities;
  /** Deterministic trigger predicate. Must not perform I/O. */
  matches(message: NormalizedMessage, now?: Date): boolean;
  /** The Gmail search used to find candidate messages. */
  gmailQuery(config: Config): string;
  execute(trigger: WorkflowTrigger, context: WorkflowContext): Promise<WorkflowResult>;
}
