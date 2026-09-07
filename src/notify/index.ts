import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { GuardedMailer } from '../email/sender.js';
import type { GmailSender } from '../gmail/types.js';

/**
 * Failure notifications (Phase 14).
 *
 * A failed automation tells the operator once, with enough detail to act on,
 * and stops. It never silently retries forever, and it never includes tokens,
 * credentials, or raw email content.
 */

export interface FailureNotice {
  workflowName: string;
  stage: string;
  /** Billing period, or the message id when no period was determined. */
  subjectRef: string;
  error: string;
  manualInterventionRequired: boolean;
  instructions?: string;
}

/** Belt and braces: strip anything token-shaped before a notice leaves the process. */
export function redactSecrets(text: string): string {
  return text
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[redacted-token]')
    .replace(/1\/\/[A-Za-z0-9._-]{20,}/g, '[redacted-refresh-token]')
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted-jwt]')
    .replace(/(client_secret|password|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]');
}

export function formatNotice(notice: FailureNotice): { subject: string; body: string } {
  const subject = `[automation] ${notice.workflowName} failed at ${notice.stage}`;
  const body = redactSecrets(
    [
      `Workflow:            ${notice.workflowName}`,
      `Failed at stage:     ${notice.stage}`,
      `Bill / message:      ${notice.subjectRef}`,
      `Manual intervention: ${notice.manualInterventionRequired ? 'YES' : 'no'}`,
      '',
      'Error:',
      notice.error,
      ...(notice.instructions ? ['', 'What to do:', notice.instructions] : []),
    ].join('\n'),
  );
  return { subject, body };
}

export interface Notifier {
  notifyFailure(notice: FailureNotice): Promise<void>;
}

/** Always-available notifier: writes the notice to the structured log. */
export class LogNotifier implements Notifier {
  constructor(private readonly logger: Logger) {}

  async notifyFailure(notice: FailureNotice): Promise<void> {
    const { subject, body } = formatNotice(notice);
    this.logger.error({ notification: subject, manualIntervention: notice.manualInterventionRequired }, body);
  }
}

/** Emails the notice, and always logs it too so a send failure is never silent. */
export class EmailNotifier implements Notifier {
  private readonly fallback: LogNotifier;

  constructor(
    private readonly mailer: GuardedMailer,
    private readonly recipient: string,
    private readonly logger: Logger,
  ) {
    this.fallback = new LogNotifier(logger);
  }

  async notifyFailure(notice: FailureNotice): Promise<void> {
    await this.fallback.notifyFailure(notice);
    const { subject, body } = formatNotice(notice);
    try {
      await this.mailer.send({ to: this.recipient, subject, bodyText: body });
    } catch (error) {
      this.logger.warn({ err: (error as Error).message }, 'failure notification could not be emailed');
    }
  }
}

export function buildNotifier(config: Config, logger: Logger, sender?: GmailSender): Notifier {
  if (!config.notifyEmail) return new LogNotifier(logger);
  const mailer = new GuardedMailer([config.notifyEmail], config.dryRun, sender);
  return new EmailNotifier(mailer, config.notifyEmail, logger);
}
