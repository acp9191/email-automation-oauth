import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../../src/config/index.js';
import { openDatabase } from '../../src/storage/db.js';
import { Repository } from '../../src/storage/repository.js';
import type {
  AttachmentRef,
  GmailProfile,
  GmailReader,
  GmailSender,
  NormalizedMessage,
  SendEmailInput,
  SendEmailResult,
} from '../../src/gmail/types.js';
import type { Notifier, FailureNotice } from '../../src/notify/index.js';

/** Test doubles and builders. No test touches a real Gmail account or the network. */

export const WORK_EMAIL = 'avery.work@example-corp.com';

export function makeConfig(overrides: Record<string, string> = {}): Config {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-test-'));
  return loadConfig({
    DRY_RUN: 'true',
    LOG_LEVEL: 'silent',
    LOG_PRETTY: 'false',
    DATA_DIR: dataDir,
    WORK_EMAIL,
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    VERIZON_ALLOWED_DOMAINS: 'verizon.com,www.verizon.com,secure.verizon.com',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export function makeRepository(): Repository {
  return new Repository(openDatabase(':memory:'));
}

/** A byte sequence that passes `verifyPdf`. */
export function makePdf(label = 'test-bill'): Buffer {
  const filler = 'x'.repeat(700);
  return Buffer.from(`%PDF-1.4\n% ${label}\n${filler}\ntrailer\n<<>>\n%%EOF\n`, 'latin1');
}

export interface MessageOverrides {
  id?: string;
  from?: string;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  internalDate?: Date;
  attachments?: AttachmentRef[];
}

const DEFAULT_BODY = [
  'Your Verizon bill is ready to view.',
  '',
  'Account ending in 4417',
  'Billing period: Jul 20 - Aug 19, 2026',
  'Total amount due: $84.99',
  '',
  'View your bill: https://secure.verizon.com/billing/statement.pdf',
].join('\n');

export function makeMessage(overrides: MessageOverrides = {}): NormalizedMessage {
  const from = overrides.from ?? 'VerizonNotification@verizon.com';
  const subject = overrides.subject ?? 'Your Verizon bill is ready';
  const internalDate = overrides.internalDate ?? new Date('2026-08-22T14:03:00Z');

  return {
    id: overrides.id ?? 'msg-0001',
    threadId: 'thread-0001',
    internalDate,
    labelIds: ['INBOX'],
    headers: { from, subject, to: 'avery@example.com' },
    from: { name: null, email: from.toLowerCase() },
    to: [{ name: null, email: 'avery@example.com' }],
    subject,
    snippet: subject,
    bodyText: overrides.bodyText ?? DEFAULT_BODY,
    bodyHtml: overrides.bodyHtml ?? '',
    attachments: overrides.attachments ?? [],
  };
}

export function pdfAttachment(filename = 'bill.pdf', size = 900): AttachmentRef {
  return { partId: '1', attachmentId: 'att-1', filename, mimeType: 'application/pdf', size };
}

export class FakeGmailReader implements GmailReader {
  public searchCalls: Array<{ query: string; maxResults: number }> = [];
  public failNextAttachment: Error | null = null;
  public failNextGet: Error | null = null;

  constructor(
    private readonly messages: NormalizedMessage[] = [],
    private readonly attachments: Record<string, Buffer> = {},
  ) {}

  async getProfile(): Promise<GmailProfile> {
    return { emailAddress: 'avery@example.com', messagesTotal: 100, threadsTotal: 90, historyId: '1' };
  }

  async search(query: string, maxResults: number): Promise<string[]> {
    this.searchCalls.push({ query, maxResults });
    return this.messages.map((message) => message.id);
  }

  async getMessage(id: string): Promise<NormalizedMessage> {
    if (this.failNextGet) {
      const error = this.failNextGet;
      this.failNextGet = null;
      throw error;
    }
    const found = this.messages.find((message) => message.id === id);
    if (!found) throw new Error(`no such message ${id}`);
    return found;
  }

  async getAttachment(_messageId: string, attachmentId: string): Promise<Buffer> {
    if (this.failNextAttachment) {
      const error = this.failNextAttachment;
      this.failNextAttachment = null;
      throw error;
    }
    const found = this.attachments[attachmentId];
    if (!found) throw new Error(`no such attachment ${attachmentId}`);
    return found;
  }
}

export class FakeGmailSender implements GmailSender {
  public sent: SendEmailInput[] = [];
  public failWith: Error | null = null;

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (this.failWith) throw this.failWith;
    this.sent.push(input);
    return { messageId: `sent-${this.sent.length}`, threadId: 'thread-out' };
  }
}

export class RecordingNotifier implements Notifier {
  public notices: FailureNotice[] = [];

  async notifyFailure(notice: FailureNotice): Promise<void> {
    this.notices.push(notice);
  }
}
