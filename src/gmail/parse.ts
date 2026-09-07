import type { gmail_v1 } from 'googleapis';
import type { AttachmentRef, EmailAddress, NormalizedMessage } from './types.js';

/**
 * Pure parsing of the Gmail API message shape into `NormalizedMessage`.
 * No network, no config — so detection logic can be tested against fixtures.
 */

export function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function parseAddress(raw: string | undefined): EmailAddress | null {
  if (!raw) return null;
  const angled = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(raw);
  if (angled) {
    const name = angled[1]?.replace(/^"|"$/g, '').trim() ?? '';
    return { name: name.length > 0 ? name : null, email: (angled[2] ?? '').trim().toLowerCase() };
  }
  const trimmed = raw.trim();
  if (!trimmed.includes('@')) return null;
  return { name: null, email: trimmed.toLowerCase() };
}

export function parseAddressList(raw: string | undefined): EmailAddress[] {
  if (!raw) return [];
  // Naive split is fine here: display names containing commas only affect the
  // `name` field, and nothing security-relevant is decided from it.
  return raw
    .split(',')
    .map((part) => parseAddress(part))
    .filter((address): address is EmailAddress => address !== null);
}

/** Returns the domain of an address, lowercased, or null. */
export function domainOf(address: EmailAddress | null): string | null {
  if (!address) return null;
  const at = address.email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = address.email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

interface Collected {
  text: string[];
  html: string[];
  attachments: AttachmentRef[];
}

function walk(part: gmail_v1.Schema$MessagePart | undefined, out: Collected): void {
  if (!part) return;

  const mimeType = (part.mimeType ?? '').toLowerCase();
  const filename = part.filename ?? '';
  const body = part.body;

  const isAttachment = filename.length > 0 && (body?.attachmentId != null || (body?.size ?? 0) > 0);

  if (isAttachment) {
    out.attachments.push({
      partId: part.partId ?? '',
      attachmentId: body?.attachmentId ?? null,
      filename,
      mimeType: mimeType || 'application/octet-stream',
      size: body?.size ?? 0,
    });
  } else if (body?.data) {
    const decoded = decodeBase64Url(body.data).toString('utf8');
    if (mimeType === 'text/plain') out.text.push(decoded);
    else if (mimeType === 'text/html') out.html.push(decoded);
  }

  for (const child of part.parts ?? []) walk(child, out);
}

export function normalizeMessage(message: gmail_v1.Schema$Message): NormalizedMessage {
  const headers: Record<string, string> = {};
  for (const header of message.payload?.headers ?? []) {
    if (header.name) headers[header.name.toLowerCase()] = header.value ?? '';
  }

  const collected: Collected = { text: [], html: [], attachments: [] };
  walk(message.payload, collected);

  const internalDateMs = Number(message.internalDate ?? 0);

  return {
    id: message.id ?? '',
    threadId: message.threadId ?? '',
    internalDate: new Date(Number.isFinite(internalDateMs) && internalDateMs > 0 ? internalDateMs : 0),
    labelIds: message.labelIds ?? [],
    headers,
    from: parseAddress(headers.from),
    to: parseAddressList(headers.to),
    subject: headers.subject ?? '',
    snippet: message.snippet ?? '',
    bodyText: collected.text.join('\n'),
    bodyHtml: collected.html.join('\n'),
    attachments: collected.attachments,
  };
}

/** Strips tags/entities so HTML-only mail can be scanned by the same rules as plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The text detection rules run against: plain text if present, else flattened HTML. */
export function searchableText(message: NormalizedMessage): string {
  const text = message.bodyText.trim();
  if (text.length > 0) return text;
  if (message.bodyHtml.trim().length > 0) return htmlToText(message.bodyHtml);
  return message.snippet;
}
