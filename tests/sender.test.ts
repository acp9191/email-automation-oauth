import { describe, expect, it } from 'vitest';
import {
  GuardedMailer,
  InvalidEmailError,
  RecipientNotAllowedError,
  isValidAddress,
} from '../src/email/sender.js';
import { buildMimeMessage } from '../src/gmail/client.js';
import { FakeGmailSender, WORK_EMAIL, makePdf } from './helpers/factories.js';

describe('recipient validation', () => {
  const mailer = new GuardedMailer([WORK_EMAIL], false, new FakeGmailSender());

  it('accepts the configured work email', () => {
    expect(mailer.validateRecipient(WORK_EMAIL)).toBe(WORK_EMAIL);
  });

  it('is case and whitespace insensitive', () => {
    expect(mailer.validateRecipient(`  ${WORK_EMAIL.toUpperCase()} `)).toBe(WORK_EMAIL);
  });

  it('refuses any other address', async () => {
    await expect(
      mailer.send({ to: 'attacker@example.com', subject: 's', bodyText: 'b' }),
    ).rejects.toBeInstanceOf(RecipientNotAllowedError);
  });

  it('refuses an address on a look-alike domain', () => {
    expect(() => mailer.validateRecipient('avery.work@example-corp.com.evil.test')).toThrow(RecipientNotAllowedError);
  });

  it('refuses a malformed address', () => {
    expect(() => mailer.validateRecipient('not-an-email')).toThrow(InvalidEmailError);
  });

  it('refuses everything when no recipient is configured', () => {
    const locked = new GuardedMailer([], false, new FakeGmailSender());
    expect(() => locked.validateRecipient(WORK_EMAIL)).toThrow(RecipientNotAllowedError);
  });

  it('validates address syntax', () => {
    expect(isValidAddress('a@b.co')).toBe(true);
    expect(isValidAddress('a@b')).toBe(false);
    expect(isValidAddress('a b@c.co')).toBe(false);
  });
});

describe('header injection', () => {
  const sender = new FakeGmailSender();
  const mailer = new GuardedMailer([WORK_EMAIL], false, sender);

  it('refuses a subject containing a line break', async () => {
    await expect(
      mailer.send({
        to: WORK_EMAIL,
        subject: 'Bill\r\nBcc: attacker@example.com',
        bodyText: 'b',
      }),
    ).rejects.toThrow(/header injection/);
    expect(sender.sent).toHaveLength(0);
  });
});

describe('MIME construction', () => {
  it('builds a multipart message with the PDF attached', () => {
    const raw = buildMimeMessage({
      to: WORK_EMAIL,
      subject: 'Verizon Internet Bill — August 2026 Reimbursement',
      bodyText: 'Attached is my bill.',
      attachments: [{ filename: 'Verizon_Internet_August_2026.pdf', mimeType: 'application/pdf', content: makePdf() }],
    });

    expect(raw).toContain(`To: ${WORK_EMAIL}`);
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('Content-Disposition: attachment; filename="Verizon_Internet_August_2026.pdf"');
    // Non-ASCII subject is RFC 2047 encoded rather than emitted raw.
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
  });

  it('sanitises an attachment filename before it reaches a header', () => {
    const raw = buildMimeMessage({
      to: WORK_EMAIL,
      subject: 'x',
      bodyText: 'b',
      attachments: [{ filename: 'a"; name="b.pdf', mimeType: 'application/pdf', content: makePdf() }],
    });
    expect(raw).not.toContain('a"; name="b.pdf');
  });
});

describe('dry-run mode', () => {
  it('performs no send and reports what it would do', async () => {
    const sender = new FakeGmailSender();
    const mailer = new GuardedMailer([WORK_EMAIL], true, sender);

    const outcome = await mailer.send({
      to: WORK_EMAIL,
      subject: 'Verizon Internet Bill — August 2026 Reimbursement',
      bodyText: 'body',
      attachments: [{ filename: 'Verizon_Internet_August_2026.pdf', mimeType: 'application/pdf', content: makePdf() }],
    });

    expect(outcome).toMatchObject({ sent: false, dryRun: true, messageId: null, to: WORK_EMAIL });
    expect(outcome.attachmentNames).toEqual(['Verizon_Internet_August_2026.pdf']);
    expect(sender.sent).toHaveLength(0);
  });

  it('still enforces the recipient allowlist in dry-run mode', async () => {
    const mailer = new GuardedMailer([WORK_EMAIL], true, new FakeGmailSender());
    await expect(mailer.send({ to: 'attacker@example.com', subject: 's', bodyText: 'b' })).rejects.toThrow(
      RecipientNotAllowedError,
    );
  });
});
