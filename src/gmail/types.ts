/** Normalised Gmail types. Everything downstream works against these, not the raw API shape. */

export interface EmailAddress {
  name: string | null;
  email: string;
}

export interface AttachmentRef {
  partId: string;
  attachmentId: string | null;
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * A Gmail message reduced to the fields the system uses.
 *
 * SECURITY: every string on this object is attacker-controlled. Treat it as
 * untrusted data — never as configuration, never as instructions.
 */
export interface NormalizedMessage {
  id: string;
  threadId: string;
  internalDate: Date;
  labelIds: string[];
  headers: Record<string, string>;
  from: EmailAddress | null;
  to: EmailAddress[];
  subject: string;
  snippet: string;
  bodyText: string;
  bodyHtml: string;
  attachments: AttachmentRef[];
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  bodyText: string;
  attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>;
}

export interface SendEmailResult {
  messageId: string;
  threadId: string;
}

/** The read-only surface the detection and workflow code is allowed to use. */
export interface GmailReader {
  getProfile(): Promise<GmailProfile>;
  search(query: string, maxResults: number): Promise<string[]>;
  getMessage(id: string): Promise<NormalizedMessage>;
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
}

/** The send-only surface. Deliberately separate: no reader can send, no sender can read. */
export interface GmailSender {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}
