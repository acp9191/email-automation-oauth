import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuardedMailer } from '../src/email/sender.js';
import { WorkflowRunner } from '../src/workflows/runner.js';
import { VerizonBillReimbursementWorkflow } from '../src/workflows/verizon-bill.js';
import { AttachmentBillSource, DirectLinkBillSource } from '../src/bill/source.js';
import { VerizonPortalBillSource } from '../src/browser/verizon-portal.js';
import type { Config } from '../src/config/index.js';
import {
  FakeGmailReader,
  FakeGmailSender,
  RecordingNotifier,
  WORK_EMAIL,
  makeConfig,
  makeMessage,
  makePdf,
  makeRepository,
  pdfAttachment,
  testClock,
} from './helpers/factories.js';
import type { NormalizedMessage } from '../src/gmail/types.js';

/**
 * End-to-end workflow behaviour, with Gmail and the network faked.
 * No test here can reach a real mailbox, a real Verizon host, or the internet.
 */

interface Harness {
  config: Config;
  reader: FakeGmailReader;
  sender: FakeGmailSender;
  notifier: RecordingNotifier;
  repository: ReturnType<typeof makeRepository>;
  runner: WorkflowRunner;
  workflow: VerizonBillReimbursementWorkflow;
}

function harness(options: {
  message: NormalizedMessage;
  attachments?: Record<string, Buffer>;
  dryRun?: boolean;
}): Harness {
  const config = makeConfig({ DRY_RUN: options.dryRun === false ? 'false' : 'true' });
  const reader = new FakeGmailReader([options.message], options.attachments ?? {});
  const sender = new FakeGmailSender();
  const repository = makeRepository();
  const notifier = new RecordingNotifier();
  const mailer = new GuardedMailer([config.workEmail], config.dryRun, sender);
  const runner = new WorkflowRunner(config, repository, reader, mailer, notifier, testClock);
  const workflow = new VerizonBillReimbursementWorkflow(config, undefined, [
    new AttachmentBillSource(),
    new DirectLinkBillSource(),
    new VerizonPortalBillSource(config),
  ]);
  return { config, reader, sender, notifier, repository, runner, workflow };
}

beforeEach(() => {
  // Any real network attempt is a test failure, not a slow test.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network disabled in tests');
    }),
  );
});

describe('dry-run behaviour', () => {
  it('obtains and stores the bill but sends nothing', async () => {
    const message = makeMessage({ attachments: [pdfAttachment()] });
    const h = harness({ message, attachments: { 'att-1': makePdf() } });

    const result = await h.runner.run(h.workflow, { source: 'manual', message });

    expect(result.status).toBe('success');
    expect(result.details).toMatchObject({
      billingPeriod: '2026-08',
      filename: 'Verizon_Internet_August_2026.pdf',
      recipient: WORK_EMAIL,
      sent: false,
      subject: 'Verizon Internet Bill — August 2026 Reimbursement',
    });
    expect(h.sender.sent).toHaveLength(0);

    // Recorded as a dry run, which must NOT block a later real send.
    expect(h.repository.hasCompleted(message.id, h.workflow.id)).toBe(false);
    expect(h.repository.find(message.id, h.workflow.id)?.status).toBe('dry_run');
  });
});

describe('live send', () => {
  it('sends exactly one email to the configured work address', async () => {
    const message = makeMessage({ attachments: [pdfAttachment()] });
    const h = harness({ message, attachments: { 'att-1': makePdf() }, dryRun: false });

    const result = await h.runner.run(h.workflow, { source: 'manual', message });

    expect(result.status).toBe('success');
    expect(h.sender.sent).toHaveLength(1);
    const sent = h.sender.sent[0]!;
    expect(sent.to).toBe(WORK_EMAIL);
    expect(sent.subject).toBe('Verizon Internet Bill — August 2026 Reimbursement');
    expect(sent.attachments?.[0]?.filename).toBe('Verizon_Internet_August_2026.pdf');
    expect(sent.bodyText).toContain('Verizon internet bill for August 2026');
    expect(h.repository.hasCompleted(message.id, h.workflow.id)).toBe(true);
  });

  it('writes the artifact with a useful filename inside the artifact directory', async () => {
    const message = makeMessage({ attachments: [pdfAttachment('statement.pdf')] });
    const h = harness({ message, attachments: { 'att-1': makePdf() }, dryRun: false });

    const result = await h.runner.run(h.workflow, { source: 'manual', message });
    const storedPath = String(result.details.storedPath);

    expect(storedPath.startsWith(h.config.artifactDir)).toBe(true);
    expect(storedPath.endsWith('Verizon_Internet_August_2026.pdf')).toBe(true);
  });
});

describe('idempotency', () => {
  it('does not send a second time for the same message', async () => {
    const message = makeMessage({ attachments: [pdfAttachment()] });
    const h = harness({ message, attachments: { 'att-1': makePdf() }, dryRun: false });

    const first = await h.runner.run(h.workflow, { source: 'manual', message });
    const second = await h.runner.run(h.workflow, { source: 'manual', message });

    expect(first.status).toBe('success');
    expect(second.status).toBe('skipped');
    expect(second.stage).toBe('idempotency');
    expect(h.sender.sent).toHaveLength(1);
  });

  it('re-sends only when explicitly forced', async () => {
    const message = makeMessage({ attachments: [pdfAttachment()] });
    const h = harness({ message, attachments: { 'att-1': makePdf() }, dryRun: false });

    await h.runner.run(h.workflow, { source: 'manual', message });
    const forced = await h.runner.run(h.workflow, { source: 'manual', message, force: true });

    expect(forced.status).toBe('success');
    expect(h.sender.sent).toHaveLength(2);
  });

  it('a prior dry run does not block the first real send', async () => {
    const message = makeMessage({ attachments: [pdfAttachment()] });
    const dry = harness({ message, attachments: { 'att-1': makePdf() } });
    await dry.runner.run(dry.workflow, { source: 'manual', message });
    expect(dry.sender.sent).toHaveLength(0);

    const live = harness({ message, attachments: { 'att-1': makePdf() }, dryRun: false });
    const result = await live.runner.run(live.workflow, { source: 'manual', message });
    expect(result.status).toBe('success');
    expect(live.sender.sent).toHaveLength(1);
  });

  it('records every attempt for the same message', async () => {
    const message = makeMessage({ attachments: [pdfAttachment()] });
    const h = harness({ message, attachments: { 'att-1': makePdf() }, dryRun: false });

    await h.runner.run(h.workflow, { source: 'manual', message });
    await h.runner.run(h.workflow, { source: 'manual', message, force: true });

    expect(h.repository.find(message.id, h.workflow.id)?.attempts).toBe(2);
    expect(h.repository.recentRuns().length).toBe(2);
  });
});

describe('detection gate', () => {
  it('skips a message the detector rejects, even when run manually', async () => {
    const message = makeMessage({ from: 'attacker@evil.example' });
    const h = harness({ message, dryRun: false });

    const result = await h.runner.run(h.workflow, { source: 'manual', message });

    expect(result.status).toBe('skipped');
    expect(result.stage).toBe('detect');
    expect(h.sender.sent).toHaveLength(0);
  });
});

describe('failure handling', () => {
  it('asks for manual intervention when no bill can be obtained', async () => {
    const message = makeMessage({ bodyText: 'Your Verizon bill is ready. Account 4417. Sign in to view.' });
    const h = harness({ message, dryRun: false });

    const result = await h.runner.run(h.workflow, { source: 'manual', message });

    expect(result.status).toBe('needs_intervention');
    expect(result.stage).toBe('acquire-bill');
    expect(result.instructions).toContain('run-verizon');
    expect(h.sender.sent).toHaveLength(0);
    expect(h.notifier.notices).toHaveLength(1);
    expect(h.notifier.notices[0]).toMatchObject({ manualInterventionRequired: true, stage: 'acquire-bill' });
  });

  it('surfaces the first source that asked for help, not the last', async () => {
    // Sources are ordered by preference, so the first to ask for help has the
    // most actionable instructions; later ones must not clobber it.
    const message = makeMessage({ bodyText: 'Your Verizon bill is ready. Account 4417. Sign in to view.' });
    const config = makeConfig({ DRY_RUN: 'false' });
    const repository = makeRepository();
    const notifier = new RecordingNotifier();
    const sender = new FakeGmailSender();
    const runner = new WorkflowRunner(
      config,
      repository,
      new FakeGmailReader([message]),
      new GuardedMailer([config.workEmail], false, sender),
      notifier,
      testClock,
    );
    const workflow = new VerizonBillReimbursementWorkflow(config, undefined, [
      new AttachmentBillSource(),
      new VerizonPortalBillSource(config),
    ]);

    const result = await runner.run(workflow, { source: 'manual', message });

    expect(result.status).toBe('needs_intervention');
    expect(result.instructions).toContain('--interactive');
    expect(sender.sent).toHaveLength(0);
  });

  it('refuses an attachment that is not really a PDF', async () => {
    const message = makeMessage({ attachments: [pdfAttachment('bill.pdf')] });
    const fakePdf = Buffer.from(`<html><body>${'Sign in '.repeat(200)}</body></html>`);
    const h = harness({ message, attachments: { 'att-1': fakePdf }, dryRun: false });

    const result = await h.runner.run(h.workflow, { source: 'manual', message });

    expect(result.status).toBe('needs_intervention');
    expect(h.sender.sent).toHaveLength(0);
  });

  it('records a failure when the Gmail API errors', async () => {
    const message = makeMessage({ attachments: [pdfAttachment()] });
    const h = harness({ message, attachments: { 'att-1': makePdf() }, dryRun: false });
    h.reader.failNextAttachment = new Error('Gmail attachments.get failed: 503 backend error');

    const result = await h.runner.run(h.workflow, { source: 'manual', message });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('503');
    expect(h.sender.sent).toHaveLength(0);
    expect(h.repository.find(message.id, h.workflow.id)?.status).toBe('failed');
    expect(h.notifier.notices).toHaveLength(1);
  });

  it('records a failure when sending fails, and does not mark the bill as done', async () => {
    const message = makeMessage({ attachments: [pdfAttachment()] });
    const h = harness({ message, attachments: { 'att-1': makePdf() }, dryRun: false });
    h.sender.failWith = new Error('Gmail messages.send failed: 429 rate limited');

    const result = await h.runner.run(h.workflow, { source: 'manual', message });

    expect(result.status).toBe('failed');
    expect(result.stage).toBe('send');
    expect(h.repository.hasCompleted(message.id, h.workflow.id)).toBe(false);
    expect(h.notifier.notices[0]?.stage).toBe('send');
  });

  it('a failed run can be retried and then succeed', async () => {
    const message = makeMessage({ attachments: [pdfAttachment()] });
    const h = harness({ message, attachments: { 'att-1': makePdf() }, dryRun: false });

    h.sender.failWith = new Error('transient');
    const first = await h.runner.run(h.workflow, { source: 'manual', message });
    expect(first.status).toBe('failed');

    h.sender.failWith = null;
    const second = await h.runner.run(h.workflow, { source: 'manual', message });
    expect(second.status).toBe('success');
    expect(h.sender.sent).toHaveLength(1);
    expect(h.repository.find(message.id, h.workflow.id)?.attempts).toBe(2);
  });
});

describe('operator-supplied bill', () => {
  it('accepts a manually downloaded PDF and completes the workflow', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const message = makeMessage({ bodyText: 'Your Verizon bill is ready. Account 4417. Sign in to view.' });
    const h = harness({ message, dryRun: false });

    const billPath = path.join(h.config.dataDir, 'manual-bill.pdf');
    fs.writeFileSync(billPath, makePdf('manual'));

    const result = await h.runner.run(h.workflow, { source: 'manual', message, billPath });

    expect(result.status).toBe('success');
    expect(h.sender.sent).toHaveLength(1);
    expect(result.details.origin).toBe('browser');
  });

  it('rejects an operator-supplied file that is not a PDF', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const message = makeMessage();
    const h = harness({ message, dryRun: false });

    const billPath = path.join(h.config.dataDir, 'not-a-bill.txt');
    fs.writeFileSync(billPath, 'just some text');

    const result = await h.runner.run(h.workflow, { source: 'manual', message, billPath });

    expect(result.status).toBe('failed');
    expect(result.stage).toBe('acquire-bill');
    expect(h.sender.sent).toHaveLength(0);
  });
});

describe('audit trail', () => {
  it('records each external side effect', async () => {
    const message = makeMessage({ attachments: [pdfAttachment()] });
    const h = harness({ message, attachments: { 'att-1': makePdf() }, dryRun: false });

    await h.runner.run(h.workflow, { source: 'manual', message });
    const runId = h.repository.recentRuns()[0]!.id;
    const actions = h.repository.auditForRun(runId).map((event) => event.action);

    expect(actions).toContain('bill.acquire');
    expect(actions).toContain('artifact.write');
    expect(actions).toContain('email.send');
  });

  it('marks a dry run as simulated rather than sent', async () => {
    const message = makeMessage({ attachments: [pdfAttachment()] });
    const h = harness({ message, attachments: { 'att-1': makePdf() } });

    await h.runner.run(h.workflow, { source: 'manual', message });
    const runId = h.repository.recentRuns()[0]!.id;
    const actions = h.repository.auditForRun(runId).map((event) => event.action);

    expect(actions).toContain('email.send.simulated');
    expect(actions).not.toContain('email.send');
  });
});
