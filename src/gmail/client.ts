import { google, type gmail_v1 } from 'googleapis';
import type { Config } from '../config/index.js';
import { childLogger } from '../logging/index.js';
import { getAuthorizedClient } from './auth.js';
import { normalizeMessage } from './parse.js';
import type {
  GmailProfile,
  GmailReader,
  GmailSender,
  NormalizedMessage,
  SendEmailInput,
  SendEmailResult,
} from './types.js';

export class GmailApiError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'GmailApiError';
  }
}

function wrap<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  return fn().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GmailApiError(`Gmail ${operation} failed: ${detail}`, error);
  });
}

/** Read-only Gmail client, backed by the gmail.readonly credential profile. */
export class GmailReadClient implements GmailReader {
  private cached: gmail_v1.Gmail | undefined;
  private readonly log = childLogger({ component: 'gmail.read' });

  constructor(private readonly config: Config) {}

  /**
   * Credentials are resolved on first use, not at construction, so commands
   * that only report configuration (`status`, `health`) work before `auth`.
   */
  private get api(): gmail_v1.Gmail {
    if (!this.cached) {
      this.cached = google.gmail({ version: 'v1', auth: getAuthorizedClient(this.config, 'read') });
    }
    return this.cached;
  }

  async getProfile(): Promise<GmailProfile> {
    return wrap('getProfile', async () => {
      const { data } = await this.api.users.getProfile({ userId: 'me' });
      return {
        emailAddress: data.emailAddress ?? '',
        messagesTotal: data.messagesTotal ?? 0,
        threadsTotal: data.threadsTotal ?? 0,
        historyId: data.historyId ?? '',
      };
    });
  }

  async search(query: string, maxResults: number): Promise<string[]> {
    return wrap('messages.list', async () => {
      const { data } = await this.api.users.messages.list({ userId: 'me', q: query, maxResults });
      const ids = (data.messages ?? []).map((message) => message.id).filter((id): id is string => !!id);
      this.log.debug({ query, found: ids.length }, 'gmail search');
      return ids;
    });
  }

  async getMessage(id: string): Promise<NormalizedMessage> {
    return wrap('messages.get', async () => {
      const { data } = await this.api.users.messages.get({ userId: 'me', id, format: 'full' });
      return normalizeMessage(data);
    });
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    return wrap('attachments.get', async () => {
      const { data } = await this.api.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId,
      });
      if (!data.data) throw new Error('attachment had no data');
      return Buffer.from(data.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    });
  }
}

function encodeHeaderValue(value: string): string {
  // RFC 2047 encode anything non-ASCII so subjects survive intact.
   
  return /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Sanitises a filename before it is placed in a MIME header. */
function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'attachment';
}

export function buildMimeMessage(input: SendEmailInput): string {
  const boundary = `bnd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const attachments = input.attachments ?? [];

  const headers = [
    `To: ${input.to}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    'MIME-Version: 1.0',
  ];

  if (attachments.length === 0) {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    return `${headers.join('\r\n')}\r\n\r\n${input.bodyText}`;
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    input.bodyText,
  ];

  for (const attachment of attachments) {
    const filename = safeFilename(attachment.filename);
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      attachment.content.toString('base64').replace(/(.{76})/g, '$1\r\n'),
    );
  }

  parts.push(`--${boundary}--`, '');
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

/** Send-only Gmail client, backed by the gmail.send credential profile. */
export class GmailSendClient implements GmailSender {
  private cached: gmail_v1.Gmail | undefined;

  constructor(private readonly config: Config) {}

  private get api(): gmail_v1.Gmail {
    if (!this.cached) {
      this.cached = google.gmail({ version: 'v1', auth: getAuthorizedClient(this.config, 'send') });
    }
    return this.cached;
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    return wrap('messages.send', async () => {
      const raw = Buffer.from(buildMimeMessage(input), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      const { data } = await this.api.users.messages.send({ userId: 'me', requestBody: { raw } });
      return { messageId: data.id ?? '', threadId: data.threadId ?? '' };
    });
  }
}
