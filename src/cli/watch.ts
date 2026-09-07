import { GmailPollingSource } from '../triggers/gmail-poll.js';
import { getWorkflow } from '../workflows/registry.js';
import { childLogger } from '../logging/index.js';
import { buildContext } from './context.js';
import { banner } from './output.js';

/* eslint-disable no-console */

const WORKFLOW_ID = 'verizon-bill-reimbursement';

/**
 * Long-running polling loop (Phase 11, first implementation).
 *
 * The workflow engine does not know it was polled: swapping this for a Gmail
 * push subscription means writing another `EventSource` and nothing else.
 */
export interface WatchOptions {
  intervalSeconds?: number;
  /**
   * Poll once and exit, instead of looping.
   *
   * This is the shape a scheduler wants: launchd or cron owns the timing, and
   * a laptop runs nothing between checks. Unattended semantics still apply, so
   * a bill that needs a human is not re-notified on the next run.
   */
  once?: boolean;
}

export async function watchCommand(options: WatchOptions = {}): Promise<number> {
  const context = buildContext();
  const log = childLogger({ component: 'watch' });

  try {
    const { config, reader, runner, repository } = context;
    const workflow = getWorkflow(config, WORKFLOW_ID);
    const source = new GmailPollingSource(config, reader, workflow);
    const intervalMs = (options.intervalSeconds ?? config.gmail.pollIntervalSeconds) * 1000;

    banner(config);
    console.log(
      options.once
        ? '  Single poll, then exit.\n'
        : `  Watching Gmail every ${intervalMs / 1000}s. Ctrl-C to stop.\n`,
    );

    let stopping = false;
    const stop = (): void => {
      stopping = true;
      log.info('shutdown requested');
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    while (!stopping) {
      try {
        const triggered = await source.poll();
        for (const event of triggered) {
          if (stopping) break;
          // Skips completed bills, and backs off on ones that need a human so a
          // single unfinishable bill cannot spam notifications or browser windows.
          if (!repository.shouldAttempt(event.message.id, workflow.id)) continue;
          await runner.run(workflow, { source: event.source, message: event.message });
        }
      } catch (error) {
        // A poll failure must not kill the watcher; the next tick retries.
        log.error({ err: (error as Error).message }, 'poll cycle failed');
      }

      if (stopping || options.once) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        timer.unref?.();
        const check = setInterval(() => {
          if (stopping) {
            clearTimeout(timer);
            clearInterval(check);
            resolve();
          }
        }, 250);
        check.unref?.();
      });
    }

    if (!options.once) console.log('\n  Watcher stopped.\n');
    return 0;
  } finally {
    context.close();
  }
}
