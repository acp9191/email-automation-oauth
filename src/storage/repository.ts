import { nowIso, type Database } from './db.js';

export type ProcessedStatus =
  | 'success'
  | 'failed'
  | 'skipped'
  | 'dry_run'
  | 'needs_intervention';

export interface ProcessedMessage {
  gmailMessageId: string;
  workflowId: string;
  billingPeriod: string | null;
  artifactFilename: string | null;
  artifactSha256: string | null;
  status: ProcessedStatus;
  outgoingMessageId: string | null;
  error: string | null;
  attempts: number;
  dryRun: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRun {
  id: number;
  workflowId: string;
  gmailMessageId: string | null;
  triggerSource: string;
  status: string;
  stage: string | null;
  error: string | null;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
}

interface ProcessedRow {
  gmail_message_id: string;
  workflow_id: string;
  billing_period: string | null;
  artifact_filename: string | null;
  artifact_sha256: string | null;
  status: string;
  outgoing_message_id: string | null;
  error: string | null;
  attempts: number;
  dry_run: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: number;
  workflow_id: string;
  gmail_message_id: string | null;
  trigger_source: string;
  status: string;
  stage: string | null;
  error: string | null;
  dry_run: number;
  started_at: string;
  finished_at: string | null;
}

function toProcessed(row: ProcessedRow): ProcessedMessage {
  return {
    gmailMessageId: row.gmail_message_id,
    workflowId: row.workflow_id,
    billingPeriod: row.billing_period,
    artifactFilename: row.artifact_filename,
    artifactSha256: row.artifact_sha256,
    status: row.status as ProcessedStatus,
    outgoingMessageId: row.outgoing_message_id,
    error: row.error,
    attempts: row.attempts,
    dryRun: row.dry_run === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    gmailMessageId: row.gmail_message_id,
    triggerSource: row.trigger_source,
    status: row.status,
    stage: row.stage,
    error: row.error,
    dryRun: row.dry_run === 1,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * The idempotency ledger and audit log.
 *
 * `hasCompleted` is the guard that keeps a re-run from sending a second
 * reimbursement email: a dry run never counts as completed, so switching
 * DRY_RUN off still lets the real send happen exactly once.
 */
export class Repository {
  constructor(private readonly db: Database) {}

  find(gmailMessageId: string, workflowId: string): ProcessedMessage | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM processed_messages WHERE gmail_message_id = ? AND workflow_id = ?',
      )
      .get(gmailMessageId, workflowId) as unknown as ProcessedRow | undefined;
    return row ? toProcessed(row) : undefined;
  }

  /**
   * Should an unattended trigger attempt this message now?
   *
   * A message that needs a human (or that failed) must not be retried on every
   * poll: that pops a browser window and re-notifies every cycle. Attempts back
   * off, so the operator gets one prompt per bill rather than ninety-six a day.
   * Manual runs bypass this entirely.
   */
  shouldAttempt(gmailMessageId: string, workflowId: string, now = new Date()): boolean {
    const existing = this.find(gmailMessageId, workflowId);
    if (!existing) return true;
    if (existing.status === 'success' && !existing.dryRun) return false;
    // A human is required by definition — retrying cannot change the outcome,
    // and doing so would re-notify on every poll. One prompt per bill.
    if (existing.status === 'needs_intervention') return false;

    const backoffMs = Math.min(2 ** Math.max(0, existing.attempts - 1) * 30 * 60_000, 24 * 60 * 60_000);
    return now.getTime() - new Date(existing.updatedAt).getTime() >= backoffMs;
  }

  /** True only for a real (non dry-run) success — the "do not send twice" check. */
  hasCompleted(gmailMessageId: string, workflowId: string): boolean {
    const existing = this.find(gmailMessageId, workflowId);
    return existing !== undefined && existing.status === 'success' && !existing.dryRun;
  }

  /** Creates the row if absent and bumps the attempt counter. */
  beginProcessing(gmailMessageId: string, workflowId: string): number {
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO processed_messages
           (gmail_message_id, workflow_id, status, attempts, dry_run, created_at, updated_at)
         VALUES (?, ?, 'pending', 1, 0, ?, ?)
         ON CONFLICT (gmail_message_id, workflow_id) DO UPDATE SET
           attempts   = attempts + 1,
           -- Starting another attempt must not un-send an already-sent bill.
           status     = CASE
                          WHEN processed_messages.status = 'success'
                           AND processed_messages.dry_run = 0 THEN 'success'
                          ELSE 'pending'
                        END,
           updated_at = excluded.updated_at`,
      )
      .run(gmailMessageId, workflowId, at, at);
    return this.find(gmailMessageId, workflowId)?.attempts ?? 1;
  }

  /**
   * Records the outcome of an attempt.
   *
   * A completed real send is PERMANENT: a later failed or forced attempt
   * records its error but must never downgrade the status, or the ledger would
   * forget that the bill was already reimbursed and a future run could send it
   * a second time. Only another success can update a success.
   */
  recordResult(update: {
    gmailMessageId: string;
    workflowId: string;
    status: ProcessedStatus;
    dryRun: boolean;
    billingPeriod?: string | null;
    artifactFilename?: string | null;
    artifactSha256?: string | null;
    outgoingMessageId?: string | null;
    error?: string | null;
  }): void {
    const existing = this.find(update.gmailMessageId, update.workflowId);
    const alreadySent = existing?.status === 'success' && !existing.dryRun;
    const preserveSuccess = alreadySent && update.status !== 'success';

    this.db
      .prepare(
        `UPDATE processed_messages SET
           status              = ?,
           dry_run             = ?,
           billing_period      = COALESCE(?, billing_period),
           artifact_filename   = COALESCE(?, artifact_filename),
           artifact_sha256     = COALESCE(?, artifact_sha256),
           outgoing_message_id = COALESCE(?, outgoing_message_id),
           error               = ?,
           updated_at          = ?
         WHERE gmail_message_id = ? AND workflow_id = ?`,
      )
      .run(
        preserveSuccess ? 'success' : update.status,
        preserveSuccess ? 0 : update.dryRun ? 1 : 0,
        update.billingPeriod ?? null,
        update.artifactFilename ?? null,
        update.artifactSha256 ?? null,
        update.outgoingMessageId ?? null,
        update.error ?? null,
        nowIso(),
        update.gmailMessageId,
        update.workflowId,
      );
  }

  startRun(workflowId: string, gmailMessageId: string | null, triggerSource: string, dryRun: boolean): number {
    const result = this.db
      .prepare(
        `INSERT INTO workflow_runs
           (workflow_id, gmail_message_id, trigger_source, status, dry_run, started_at)
         VALUES (?, ?, ?, 'running', ?, ?)`,
      )
      .run(workflowId, gmailMessageId, triggerSource, dryRun ? 1 : 0, nowIso());
    return Number(result.lastInsertRowid);
  }

  finishRun(runId: number, status: string, stage: string | null, error: string | null): void {
    this.db
      .prepare('UPDATE workflow_runs SET status = ?, stage = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(status, stage, error, nowIso(), runId);
  }

  /** Records an external side effect that actually happened (or was simulated). */
  audit(event: {
    runId: number | null;
    action: string;
    target?: string | null;
    detail?: Record<string, unknown> | null;
    dryRun: boolean;
  }): void {
    this.db
      .prepare('INSERT INTO audit_events (run_id, at, action, target, detail, dry_run) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        event.runId,
        nowIso(),
        event.action,
        event.target ?? null,
        event.detail ? JSON.stringify(event.detail) : null,
        event.dryRun ? 1 : 0,
      );
  }

  recentRuns(limit = 20): WorkflowRun[] {
    const rows = this.db
      .prepare('SELECT * FROM workflow_runs ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as RunRow[];
    return rows.map(toRun);
  }

  recentProcessed(limit = 20): ProcessedMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM processed_messages ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as unknown as ProcessedRow[];
    return rows.map(toProcessed);
  }

  auditForRun(runId: number): Array<{ at: string; action: string; target: string | null; dryRun: boolean }> {
    const rows = this.db
      .prepare('SELECT at, action, target, dry_run FROM audit_events WHERE run_id = ? ORDER BY id')
      .all(runId) as unknown as Array<{ at: string; action: string; target: string | null; dry_run: number }>;
    return rows.map((row) => ({ at: row.at, action: row.action, target: row.target, dryRun: row.dry_run === 1 }));
  }
}
