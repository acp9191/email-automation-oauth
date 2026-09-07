import { describe, expect, it } from 'vitest';
import { domainOf, htmlToText, normalizeMessage, parseAddress, parseAddressList } from '../src/gmail/parse.js';

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

describe('address parsing', () => {
  it('parses a display name and address', () => {
    expect(parseAddress('Verizon Notification <VerizonNotification@verizon.com>')).toEqual({
      name: 'Verizon Notification',
      email: 'verizonnotification@verizon.com',
    });
  });

  it('parses a bare address', () => {
    expect(parseAddress('billing@verizon.com')).toEqual({ name: null, email: 'billing@verizon.com' });
  });

  it('returns null for a non-address', () => {
    expect(parseAddress('undisclosed recipients')).toBeNull();
    expect(parseAddress(undefined)).toBeNull();
  });

  it('parses a list', () => {
    expect(parseAddressList('a@x.com, B <b@y.com>')).toHaveLength(2);
  });

  it('extracts the domain', () => {
    expect(domainOf({ name: null, email: 'a@Mail.Verizon.com' })).toBe('mail.verizon.com');
    expect(domainOf(null)).toBeNull();
  });

  it('is not fooled by a display name containing a different address', () => {
    const parsed = parseAddress('"billing@verizon.com" <attacker@evil.example>');
    expect(parsed?.email).toBe('attacker@evil.example');
    expect(domainOf(parsed)).toBe('evil.example');
  });
});

describe('message normalisation', () => {
  it('flattens a multipart message and collects attachments', () => {
    const message = normalizeMessage({
      id: 'm1',
      threadId: 't1',
      internalDate: String(Date.UTC(2026, 7, 22)),
      labelIds: ['INBOX'],
      snippet: 'Your Verizon bill is ready',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'Verizon <VerizonNotification@verizon.com>' },
          { name: 'Subject', value: 'Your Verizon bill is ready' },
          { name: 'To', value: 'avery@example.com' },
        ],
        parts: [
          { partId: '0', mimeType: 'text/plain', filename: '', body: { data: b64('Amount due $84.99') } },
          { partId: '1', mimeType: 'text/html', filename: '', body: { data: b64('<p>Amount due $84.99</p>') } },
          {
            partId: '2',
            mimeType: 'application/pdf',
            filename: 'bill.pdf',
            body: { attachmentId: 'att-1', size: 1234 },
          },
        ],
      },
    });

    expect(message.from?.email).toBe('verizonnotification@verizon.com');
    expect(message.subject).toBe('Your Verizon bill is ready');
    expect(message.bodyText).toContain('$84.99');
    expect(message.bodyHtml).toContain('<p>');
    expect(message.attachments).toEqual([
      { partId: '2', attachmentId: 'att-1', filename: 'bill.pdf', mimeType: 'application/pdf', size: 1234 },
    ]);
    expect(message.internalDate.toISOString().slice(0, 10)).toBe('2026-08-22');
  });

  it('survives a message with no payload', () => {
    const message = normalizeMessage({ id: 'm2' });
    expect(message.subject).toBe('');
    expect(message.attachments).toEqual([]);
    expect(message.internalDate.getTime()).toBe(0);
  });
});

describe('html flattening', () => {
  it('drops scripts and styles and keeps text', () => {
    const text = htmlToText('<style>p{color:red}</style><script>alert(1)</script><p>Bill&nbsp;ready</p>');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
    expect(text).toContain('Bill ready');
  });

  it('does not execute or resolve anything', () => {
    expect(htmlToText('<img src=x onerror=alert(1)><a href="https://evil.test">click</a>')).toContain('click');
  });
});
