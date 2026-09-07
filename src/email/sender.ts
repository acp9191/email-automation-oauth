import type { GmailSender, SendEmailInput } from '../gmail/types.js';
import { childLogger } from '../logging/index.js';

/**
 * The single chokepoint for outgoing mail.
 *
 * Design rules enforced here, not by convention:
 *  - Exactly one recipient, and it must be on the configured allowlist.
 *    The recipient is never derived from an email, an LLM, or a CLI flag.
 *  - No CC/BCC/Reply-To fields exist on this interface at all.
 *  - In dry-run mode `send` performs no network call and returns `sent: false`.
 */

export class RecipientNotAllowedError extends Error {
  constructor(attempted: string, allowed: string[]) {
    super(
      `Refusing to send to "${attempted}". Allowed recipients: ${allowed.join(', ') || '(none configured)'}`,
    );
    this.name = 'RecipientNotAllowedError';
  }
}

export class InvalidEmailError extends Error {}

const ADDRESS = /^[^\s@<>",;:\\]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function isValidAddress(address: string): boolean {
  return ADDRESS.test(address.trim());
}

/** Rejects CR/LF so a crafted subject cannot inject extra MIME headers. */
export function assertNoHeaderInjection(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new InvalidEmailError(`${field} contains a line break (header injection attempt)`);
  }
}

export interface OutboundEmail {
  to: string;
  subject: string;
  bodyText: string;
  attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>;
}

export interface SendOutcome {
  sent: boolean;
  dryRun: boolean;
  messageId: string | null;
  to: string;
  subject: string;
  attachmentNames: string[];
}

export class GuardedMailer {
  private readonly log = childLogger({ component: 'email.sender' });

  constructor(
    private readonly allowedRecipients: string[],
    private readonly dryRun: boolean,
    /** Omitted in dry-run mode so no send-capable credential is even loaded. */
    private readonly sender?: GmailSender,
  ) {}

  /** Throws unless `to` is a valid address on the allowlist. */
  validateRecipient(to: string): string {
    const normalized = to.trim().toLowerCase();
    if (!isValidAddress(normalized)) throw new InvalidEmailError(`"${to}" is not a valid email address`);
    const allowed = this.allowedRecipients.map((address) => address.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(normalized)) throw new RecipientNotAllowedError(to, allowed);
    return normalized;
  }

  async send(email: OutboundEmail): Promise<SendOutcome> {
    const to = this.validateRecipient(email.to);
    assertNoHeaderInjection('subject', email.subject);
    assertNoHeaderInjection('to', to);

    const attachmentNames = (email.attachments ?? []).map((attachment) => attachment.filename);

    if (this.dryRun) {
      this.log.info({ to, subject: email.subject, attachmentNames }, 'DRY RUN — not sending');
      return { sent: false, dryRun: true, messageId: null, to, subject: email.subject, attachmentNames };
    }

    if (!this.sender) {
      throw new InvalidEmailError('No send-capable Gmail credential is configured.');
    }

    const payload: SendEmailInput = {
      to,
      subject: email.subject,
      bodyText: email.bodyText,
      attachments: email.attachments,
    };
    const result = await this.sender.send(payload);
    this.log.info({ to, subject: email.subject, messageId: result.messageId }, 'email sent');

    return {
      sent: true,
      dryRun: false,
      messageId: result.messageId,
      to,
      subject: email.subject,
      attachmentNames,
    };
  }
}
