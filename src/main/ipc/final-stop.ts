import type { StreamEvent } from '../../shared/protocol'

/**
 * True for the stop that ends the whole exchange: untagged (not a nested specialist's own round) and not a tool-use pause.
 * The renderer treats exactly this event as "the turn is over" and stops listening (App.svelte), so anything the main
 * process emits after it is lost. The orchestrator sends a round's `usage` event after that round's `message_stop`, so
 * `runChat` holds this stop back until the run has finished — otherwise the last round's usage never reached the
 * context meter (found live, manual test 8.1: the meter stayed at 0 after a plain "hi").
 */
export function isFinalStop(event: StreamEvent): boolean {
  return event.type === 'message_stop' && !event.agentRole && event.stopReason !== 'tool_use'
}
