import type { Config } from '../config/index.js';
import type { GuardedMailer } from '../email/sender.js';
import type { GmailReader } from '../gmail/types.js';
import { childLogger, describeError } from '../logging/index.js';
import type { Notifier } from '../notify/index.js';
import type { Repository } from '../storage/repository.js';
import type { Workflow, WorkflowResult, WorkflowTrigger } from './types.js';

/**
 * Runs a workflow and owns everything around it: run records, the audit trail,
 * turning a thrown error into a recorded failure, and notifying on failure.
 *
 * Workflows therefore stay focused on their own logic and can never forget to
 * record what they did.
 */
export class WorkflowRunner {
  constructor(
    private readonly config: Config,
    private readonly repository: Repository,
    private readonly reader: GmailReader,
    private readonly mailer: GuardedMailer,
    private readonly notifier: Notifier,
  ) {}

  async run(workflow: Workflow, trigger: WorkflowTrigger): Promise<WorkflowResult> {
    const logger = childLogger({ workflow: workflow.id, trigger: trigger.source });
    const messageId = trigger.message?.id ?? null;
    const runId = this.repository.startRun(workflow.id, messageId, trigger.source, this.config.dryRun);

    logger.info({ runId, messageId, dryRun: this.config.dryRun }, 'workflow started');

    let result: WorkflowResult;
    try {
      result = await workflow.execute(trigger, {
        config: this.config,
        repository: this.repository,
        reader: this.reader,
        mailer: this.mailer,
        logger,
        runId,
        dryRun: this.config.dryRun,
        now: new Date(),
      });
    } catch (error) {
      const described = describeError(error);
      logger.error({ runId, err: described }, 'workflow threw');
      result = {
        status: 'failed',
        stage: 'record',
        summary: `${workflow.name} threw an unexpected error.`,
        details: { messageId },
        error: `${described.name}: ${described.message}`,
      };
      if (messageId) {
        this.repository.recordResult({
          gmailMessageId: messageId,
          workflowId: workflow.id,
          status: 'failed',
          dryRun: this.config.dryRun,
          error: result.error ?? null,
        });
      }
    }

    this.repository.finishRun(runId, result.status, result.stage, result.error ?? null);
    logger.info({ runId, status: result.status, stage: result.stage }, result.summary);

    if (result.status === 'failed' || result.status === 'needs_intervention') {
      await this.notifier.notifyFailure({
        workflowName: workflow.name,
        stage: result.stage,
        subjectRef: String(result.details.billingPeriod ?? messageId ?? 'unknown'),
        error: result.error ?? result.summary,
        manualInterventionRequired: result.status === 'needs_intervention',
        instructions: result.instructions,
      });
    }

    return result;
  }
}
