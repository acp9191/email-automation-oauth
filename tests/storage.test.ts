import { describe, expect, it } from 'vitest';
import { makeRepository } from './helpers/factories.js';

const WORKFLOW = 'verizon-bill-reimbursement';

describe('idempotency ledger', () => {
  it('reports nothing for an unseen message', () => {
    const repo = makeRepository();
    expect(repo.find('m1', WORKFLOW)).toBeUndefined();
    expect(repo.hasCompleted('m1', WORKFLOW)).toBe(false);
  });

  it('stores everything the plan requires about a processed bill', () => {
    const repo = makeRepository();
    repo.beginProcessing('m1', WORKFLOW);
    repo.recordResult({
      gmailMessageId: 'm1',
      workflowId: WORKFLOW,
      status: 'success',
      dryRun: false,
      billingPeriod: '2026-08',
      artifactFilename: 'Verizon_Internet_August_2026.pdf',
      artifactSha256: 'abc123',
      outgoingMessageId: 'sent-1',
    });

    const row = repo.find('m1', WORKFLOW)!;
    expect(row).toMatchObject({
      gmailMessageId: 'm1',
      billingPeriod: '2026-08',
      artifactFilename: 'Verizon_Internet_August_2026.pdf',
      artifactSha256: 'abc123',
      status: 'success',
      outgoingMessageId: 'sent-1',
      dryRun: false,
    });
    expect(row.createdAt).toBeTruthy();
    expect(row.updatedAt).toBeTruthy();
    expect(repo.hasCompleted('m1', WORKFLOW)).toBe(true);
  });

  it('does not count a dry run as completed', () => {
    const repo = makeRepository();
    repo.beginProcessing('m1', WORKFLOW);
    repo.recordResult({ gmailMessageId: 'm1', workflowId: WORKFLOW, status: 'dry_run', dryRun: true });
    expect(repo.hasCompleted('m1', WORKFLOW)).toBe(false);
  });

  it('does not count a failure as completed', () => {
    const repo = makeRepository();
    repo.beginProcessing('m1', WORKFLOW);
    repo.recordResult({ gmailMessageId: 'm1', workflowId: WORKFLOW, status: 'failed', dryRun: false, error: 'boom' });
    expect(repo.hasCompleted('m1', WORKFLOW)).toBe(false);
    expect(repo.find('m1', WORKFLOW)?.error).toBe('boom');
  });

  it('counts attempts across retries', () => {
    const repo = makeRepository();
    expect(repo.beginProcessing('m1', WORKFLOW)).toBe(1);
    expect(repo.beginProcessing('m1', WORKFLOW)).toBe(2);
    expect(repo.beginProcessing('m1', WORKFLOW)).toBe(3);
  });

  it('keeps the same message separate per workflow', () => {
    const repo = makeRepository();
    repo.beginProcessing('m1', WORKFLOW);
    repo.recordResult({ gmailMessageId: 'm1', workflowId: WORKFLOW, status: 'success', dryRun: false });
    expect(repo.hasCompleted('m1', WORKFLOW)).toBe(true);
    expect(repo.hasCompleted('m1', 'some-future-workflow')).toBe(false);
  });

  it('preserves earlier values when a later update omits them', () => {
    const repo = makeRepository();
    repo.beginProcessing('m1', WORKFLOW);
    repo.recordResult({ gmailMessageId: 'm1', workflowId: WORKFLOW, status: 'failed', dryRun: false, billingPeriod: '2026-08' });
    repo.recordResult({ gmailMessageId: 'm1', workflowId: WORKFLOW, status: 'success', dryRun: false });
    expect(repo.find('m1', WORKFLOW)?.billingPeriod).toBe('2026-08');
  });
});

describe('run and audit records', () => {
  it('records a run lifecycle', () => {
    const repo = makeRepository();
    const runId = repo.startRun(WORKFLOW, 'm1', 'manual', false);
    repo.finishRun(runId, 'success', 'record', null);

    const run = repo.recentRuns()[0]!;
    expect(run).toMatchObject({ workflowId: WORKFLOW, gmailMessageId: 'm1', triggerSource: 'manual', status: 'success', stage: 'record' });
    expect(run.finishedAt).toBeTruthy();
  });

  it('records audit events in order', () => {
    const repo = makeRepository();
    const runId = repo.startRun(WORKFLOW, 'm1', 'manual', false);
    repo.audit({ runId, action: 'bill.acquire', target: 'gmail-attachment', dryRun: false });
    repo.audit({ runId, action: 'email.send', target: 'work@example.com', dryRun: false });

    expect(repo.auditForRun(runId).map((event) => event.action)).toEqual(['bill.acquire', 'email.send']);
  });
});

describe('unattended retry backoff', () => {
  const hoursAgo = (n: number): Date => new Date(Date.now() - n * 3600_000);

  it('attempts a message it has never seen', () => {
    expect(makeRepository().shouldAttempt('m1', WORKFLOW)).toBe(true);
  });

  it('never re-attempts a completed bill', () => {
    const repo = makeRepository();
    repo.beginProcessing('m1', WORKFLOW);
    repo.recordResult({ gmailMessageId: 'm1', workflowId: WORKFLOW, status: 'success', dryRun: false });
    expect(repo.shouldAttempt('m1', WORKFLOW)).toBe(false);
  });

  it('never auto-retries a bill that needs a human, however long it waits', () => {
    const repo = makeRepository();
    repo.beginProcessing('m1', WORKFLOW);
    repo.recordResult({ gmailMessageId: 'm1', workflowId: WORKFLOW, status: 'needs_intervention', dryRun: false });

    // Retrying cannot change the outcome, so an unattended watcher must send
    // exactly one notification per bill rather than one per poll, forever.
    expect(repo.shouldAttempt('m1', WORKFLOW)).toBe(false);
    expect(repo.shouldAttempt('m1', WORKFLOW, new Date(Date.now() + 48 * 3600_000))).toBe(false);
  });

  it('does back off and retry a transient failure', () => {
    const repo = makeRepository();
    repo.beginProcessing('m1', WORKFLOW);
    repo.recordResult({ gmailMessageId: 'm1', workflowId: WORKFLOW, status: 'failed', dryRun: false });

    expect(repo.shouldAttempt('m1', WORKFLOW)).toBe(false);
    expect(repo.shouldAttempt('m1', WORKFLOW, new Date(Date.now() + 2 * 3600_000))).toBe(true);
  });

  it('widens the gap as attempts accumulate', () => {
    const repo = makeRepository();
    for (let i = 0; i < 5; i += 1) {
      repo.beginProcessing('m1', WORKFLOW);
      repo.recordResult({ gmailMessageId: 'm1', workflowId: WORKFLOW, status: 'failed', dryRun: false });
    }
    // After 5 attempts the wait is hours, not minutes.
    expect(repo.shouldAttempt('m1', WORKFLOW, new Date(Date.now() + 3600_000))).toBe(false);
    expect(repo.shouldAttempt('m1', WORKFLOW, hoursAgo(-25))).toBe(true);
  });
});

describe('a completed send is permanent', () => {
  function sent(): ReturnType<typeof makeRepository> {
    const repo = makeRepository();
    repo.beginProcessing('m1', WORKFLOW);
    repo.recordResult({
      gmailMessageId: 'm1',
      workflowId: WORKFLOW,
      status: 'success',
      dryRun: false,
      billingPeriod: '2026-08',
      outgoingMessageId: 'sent-1',
    });
    return repo;
  }

  it('a later failure does not erase the record of the send', () => {
    const repo = sent();
    repo.beginProcessing('m1', WORKFLOW);
    repo.recordResult({ gmailMessageId: 'm1', workflowId: WORKFLOW, status: 'failed', dryRun: false, error: 'boom' });

    // Without this guard a forced re-run that failed would let the bill be
    // sent a second time.
    expect(repo.hasCompleted('m1', WORKFLOW)).toBe(true);
    expect(repo.find('m1', WORKFLOW)?.error).toBe('boom');
  });

  it('a later needs_intervention does not erase it either', () => {
    const repo = sent();
    repo.recordResult({ gmailMessageId: 'm1', workflowId: WORKFLOW, status: 'needs_intervention', dryRun: false });
    expect(repo.hasCompleted('m1', WORKFLOW)).toBe(true);
  });

  it('a dry run cannot mark a real send as unsent', () => {
    const repo = sent();
    repo.recordResult({ gmailMessageId: 'm1', workflowId: WORKFLOW, status: 'dry_run', dryRun: true });
    expect(repo.hasCompleted('m1', WORKFLOW)).toBe(true);
    expect(repo.find('m1', WORKFLOW)?.dryRun).toBe(false);
  });

  it('another genuine success still updates the row', () => {
    const repo = sent();
    repo.recordResult({
      gmailMessageId: 'm1', workflowId: WORKFLOW, status: 'success', dryRun: false, outgoingMessageId: 'sent-2',
    });
    expect(repo.find('m1', WORKFLOW)?.outgoingMessageId).toBe('sent-2');
  });
});
