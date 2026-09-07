/**
 * Domain types shared between the main process (providers, agents) and the
 * renderer (rendering messages/streams). Kept here, not in src/main, so both
 * sides import the same definitions without crossing the process boundary.
 */

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

export interface Message {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; partialInput: string }
  | { type: 'message_stop'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
