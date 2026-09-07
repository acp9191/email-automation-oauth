import type { Config } from '../config/index.js';
import type { GmailReader } from '../gmail/types.js';
import { childLogger } from '../logging/index.js';
import type { Workflow } from '../workflows/types.js';
import type { EventSource, TriggeredMessage } from './types.js';

/**
 * Polling event source.
 *
 * The Gmail-side query does the coarse filtering so we never pull down the
 * whole mailbox; the workflow's own deterministic `matches` makes the real
 * decision. Replaceable by a push/Pub-Sub source without touching workflows.
 */
export class GmailPollingSource implements EventSource {
  readonly id = 'gmail-poll';
  private readonly log = childLogger({ component: 'trigger.poll' });

  constructor(
    private readonly config: Config,
    private readonly reader: GmailReader,
    private readonly workflow: Workflow,
  ) {}

  async poll(): Promise<TriggeredMessage[]> {
    const query = this.workflow.gmailQuery(this.config);
    const ids = await this.reader.search(query, this.config.gmail.maxResults);
    this.log.info({ query, candidates: ids.length }, 'gmail poll');

    const triggered: TriggeredMessage[] = [];
    for (const id of ids) {
      const message = await this.reader.getMessage(id);
      if (this.workflow.matches(message)) {
        triggered.push({ source: 'gmail-poll', message });
      }
    }
    return triggered;
  }
}
