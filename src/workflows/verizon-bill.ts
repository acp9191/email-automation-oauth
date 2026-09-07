import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/index.js';
import { requireWorkEmail } from '../config/index.js';
import {
  acquireBill,
  AttachmentBillSource,
  DirectLinkBillSource,
  type BillArtifact,
  type BillSource,
} from '../bill/source.js';
import { VerizonPortalBillSource } from '../browser/verizon-portal.js';
import { safePdfFilename, sha256, verifyPdf } from '../bill/pdf.js';
import {
  billingPeriodSlug,
  extractBillingPeriod,
  type BillingPeriod,
} from '../detection/billing-period.js';
import { isVerizonBillNotification } from '../detection/verizon.js';
import { VERIZON_BILL_RULE, type DetectionRule } from '../detection/rules.js';
import type { NormalizedMessage } from '../gmail/types.js';
import type {
  Workflow,
  WorkflowCapabilities,
  WorkflowContext,
  WorkflowResult,
  WorkflowTrigger,
} from './types.js';

/**
 * Verizon internet bill → work email, for reimbursement.
 *
 * The whole path is deterministic. Nothing read out of the email decides who
 * gets mailed, what gets attached, or whether a send happens; those come from
 * configuration and from bytes that verified as a PDF.
 */
export class VerizonBillReimbursementWorkflow implements Workflow {
  readonly id = 'verizon-bill-reimbursement';
  readonly name = 'Verizon Bill Reimbursement';
  readonly description = 'Detects the monthly Verizon bill email, obtains the PDF, and forwards it to WORK_EMAIL.';

  constructor(
    private readonly config: Config,
    private readonly rule: DetectionRule = VERIZON_BILL_RULE,
    private readonly sources: BillSource[] = [
      new AttachmentBillSource(),
      new DirectLinkBillSource(),
      new VerizonPortalBillSource(config),
    ],
  ) {}

  get capabilities(): WorkflowCapabilities {
    return {
      gmailRead: true,
      gmailSend: true,
      networkDomains: this.config.verizonAllowedDomains,
      allowedRecipients: this.config.workEmail ? [this.config.workEmail] : [],
      writableDirs: [this.config.artifactDir],
    };
  }

  matches(message: NormalizedMessage, now = new Date()): boolean {
    return isVerizonBillNotification(message, this.rule, now);
  }

  gmailQuery(config: Config): string {
    return `${this.rule.gmailQuery} newer_than:${config.gmail.lookbackDays}d`;
  }

  async execute(trigger: WorkflowTrigger, context: WorkflowContext): Promise<WorkflowResult> {
    const { message } = trigger;
    if (!message) {
      return {
        status: 'failed',
        stage: 'detect',
        summary: 'No source message supplied to the workflow.',
        details: {},
        error: 'workflow requires a Gmail message',
      };
    }

    const { repository, logger, runId, dryRun, now } = context;
    const workEmail = requireWorkEmail(this.config);

    // --- detect --------------------------------------------------------------
    if (!this.matches(message, now)) {
      return {
        status: 'skipped',
        stage: 'detect',
        summary: `Message ${message.id} is not a Verizon bill notification.`,
        details: { messageId: message.id },
      };
    }

    // --- idempotency ---------------------------------------------------------
    if (repository.hasCompleted(message.id, this.id) && !trigger.force) {
      const previous = repository.find(message.id, this.id);
      return {
        status: 'skipped',
        stage: 'idempotency',
        summary: `Already reimbursed ${previous?.billingPeriod ?? 'this bill'} from message ${message.id}; not sending again.`,
        details: {
          messageId: message.id,
          billingPeriod: previous?.billingPeriod,
          outgoingMessageId: previous?.outgoingMessageId,
          hint: 'pass --force to deliberately re-send',
        },
      };
    }
    repository.beginProcessing(message.id, this.id);

    // --- billing period ------------------------------------------------------
    const period = extractBillingPeriod(message, now);
    logger.info({ period: period.period, source: period.source, confidence: period.confidence }, 'billing period');
    repository.audit({
      runId,
      action: 'billing-period.extract',
      target: period.period,
      detail: { source: period.source, confidence: period.confidence },
      dryRun,
    });

    // --- acquire the bill ----------------------------------------------------
    let artifact: BillArtifact;
    if (trigger.billPath) {
      const manual = this.loadOperatorBill(trigger.billPath);
      if ('error' in manual) {
        return this.fail('acquire-bill', `Supplied bill file is not a valid PDF: ${manual.error}`, {
          messageId: message.id,
          billPath: trigger.billPath,
        }, message.id, period.period, repository, dryRun);
      }
      artifact = manual.artifact;
    } else {
      const acquisition = await acquireBill(this.sources, {
        message,
        reader: context.reader,
        allowedDomains: this.config.verizonAllowedDomains,
        dryRun,
      });

      if (acquisition.status === 'needs_intervention') {
        const filename = this.artifactFilename(period);
        repository.recordResult({
          gmailMessageId: message.id,
          workflowId: this.id,
          status: 'needs_intervention',
          dryRun,
          billingPeriod: period.period,
          error: acquisition.reason,
        });
        return {
          status: 'needs_intervention',
          stage: 'acquire-bill',
          summary: `Could not obtain the ${period.label} Verizon bill automatically — manual download required.`,
          details: {
            messageId: message.id,
            billingPeriod: period.period,
            billingPeriodLabel: period.label,
            expectedFilename: filename,
          },
          error: acquisition.reason,
          instructions: `${acquisition.instructions}\n\nSuggested path: ${path.join(this.config.artifactDir, filename)}\nThen run: npm run run-verizon -- --message ${message.id} --bill <path>`,
        };
      }

      if (acquisition.status === 'unavailable') {
        return this.fail('acquire-bill', `No bill PDF could be obtained: ${acquisition.reason}`, {
          messageId: message.id,
          billingPeriod: period.period,
        }, message.id, period.period, repository, dryRun);
      }

      artifact = acquisition.artifact;
    }

    repository.audit({
      runId,
      action: 'bill.acquire',
      target: artifact.origin,
      detail: { sha256: artifact.sha256, bytes: artifact.byteLength, from: artifact.originDetail },
      dryRun,
    });

    // --- store the artifact --------------------------------------------------
    const filename = this.artifactFilename(period);
    const storedPath = this.storeArtifact(filename, artifact.content);
    logger.info({ storedPath, sha256: artifact.sha256, bytes: artifact.byteLength }, 'bill stored');
    repository.audit({ runId, action: 'artifact.write', target: storedPath, detail: { sha256: artifact.sha256 }, dryRun });

    // --- send ----------------------------------------------------------------
    const subject = `Verizon Internet Bill — ${period.label} Reimbursement`;
    const bodyText = this.buildBody(period.label, filename, message.id, artifact);

    let outcome;
    try {
      outcome = await context.mailer.send({
        to: workEmail,
        subject,
        bodyText,
        attachments: [{ filename, mimeType: 'application/pdf', content: artifact.content }],
      });
    } catch (error) {
      return this.fail('send', `Sending the reimbursement email failed: ${(error as Error).message}`, {
        messageId: message.id,
        billingPeriod: period.period,
        filename,
      }, message.id, period.period, repository, dryRun);
    }

    repository.audit({
      runId,
      action: outcome.sent ? 'email.send' : 'email.send.simulated',
      target: outcome.to,
      detail: { subject, attachment: filename, messageId: outcome.messageId },
      dryRun,
    });

    // --- record --------------------------------------------------------------
    repository.recordResult({
      gmailMessageId: message.id,
      workflowId: this.id,
      status: outcome.sent ? 'success' : 'dry_run',
      dryRun: !outcome.sent,
      billingPeriod: period.period,
      artifactFilename: filename,
      artifactSha256: artifact.sha256,
      outgoingMessageId: outcome.messageId,
      error: null,
    });

    return {
      status: 'success',
      stage: 'record',
      summary: outcome.sent
        ? `Sent the ${period.label} Verizon bill to ${outcome.to}.`
        : `DRY RUN — would send the ${period.label} Verizon bill to ${outcome.to}.`,
      details: {
        messageId: message.id,
        billingPeriod: period.period,
        billingPeriodLabel: period.label,
        billingPeriodConfidence: period.confidence,
        filename,
        storedPath,
        sha256: artifact.sha256,
        bytes: artifact.byteLength,
        origin: artifact.origin,
        recipient: outcome.to,
        subject,
        sent: outcome.sent,
        outgoingMessageId: outcome.messageId,
      },
    };
  }

  private artifactFilename(period: BillingPeriod): string {
    return safePdfFilename(`Verizon_Internet_${billingPeriodSlug(period)}`);
  }

  private storeArtifact(filename: string, content: Buffer): string {
    fs.mkdirSync(this.config.artifactDir, { recursive: true, mode: 0o700 });
    // `filename` is generated by us and already sanitised; resolve anyway and
    // confirm it stayed inside the artifact directory.
    const target = path.resolve(this.config.artifactDir, filename);
    if (!target.startsWith(path.resolve(this.config.artifactDir) + path.sep)) {
      throw new Error('refusing to write outside the artifact directory');
    }
    fs.writeFileSync(target, content, { mode: 0o600 });
    return target;
  }

  private loadOperatorBill(billPath: string): { artifact: BillArtifact } | { error: string } {
    const resolved = path.resolve(billPath);
    if (!fs.existsSync(resolved)) return { error: `no such file: ${resolved}` };
    const content = fs.readFileSync(resolved);
    const check = verifyPdf(content);
    if (!check.valid) return { error: check.reason ?? 'failed verification' };
    return {
      artifact: {
        content,
        sha256: sha256(content),
        byteLength: content.byteLength,
        origin: 'browser',
        originDetail: `operator-supplied file ${resolved}`,
        suggestedName: path.basename(resolved),
      },
    };
  }

  /** Body text is fully generated. No content from the incoming email is echoed. */
  private buildBody(label: string, filename: string, messageId: string, artifact: BillArtifact): string {
    return [
      `Attached is my Verizon internet bill for ${label}, submitted for reimbursement.`,
      '',
      `Attachment: ${filename}`,
      `Billing period: ${label}`,
      '',
      '---',
      'Sent automatically by a personal automation workflow.',
      `Source: Gmail message ${messageId} (${artifact.origin})`,
      `SHA-256: ${artifact.sha256}`,
    ].join('\n');
  }

  private fail(
    stage: WorkflowResult['stage'],
    summary: string,
    details: Record<string, unknown>,
    messageId: string,
    billingPeriod: string | null,
    repository: WorkflowContext['repository'],
    dryRun: boolean,
  ): WorkflowResult {
    repository.recordResult({
      gmailMessageId: messageId,
      workflowId: this.id,
      status: 'failed',
      dryRun,
      billingPeriod,
      error: summary,
    });
    return { status: 'failed', stage, summary, details, error: summary };
  }
}
