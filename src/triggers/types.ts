import type { NormalizedMessage } from '../gmail/types.js';
import type { TriggerSource } from '../workflows/types.js';

/**
 * The event-source seam (Phase 11).
 *
 * The workflow engine only ever sees `TriggeredMessage`, so swapping polling
 * for a Gmail push subscription later is a new implementation of this
 * interface and nothing else.
 */
export interface TriggeredMessage {
  source: TriggerSource;
  message: NormalizedMessage;
}

export interface EventSource {
  readonly id: string;
  /** Yields candidate messages for a workflow to consider. */
  poll(): Promise<TriggeredMessage[]>;
}
