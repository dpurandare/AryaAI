import type { Message } from '@shared/protocol'

/**
 * Found live (manual test 9, claude-haiku-5-5): "What does the IEC 61400-26 loss category taxonomy look like?" with a wiki connected
 * went straight to web_search. The planner's `needsDomainKnowledge` flag is one model judgement; this is the backstop in code at the
 * point of action — the first open-web lookup of a turn is held back once, with a pointer to the connected knowledge servers.
 */

export const KNOWLEDGE_FIRST_REFUSAL =
  'Not run yet. A knowledge server (MCP) is connected, and a standard, rule, definition, process or technical term should be looked up there first. ' +
  'If this is that kind of question, call delegate_to_mcp_operator now with the topic; the web is the fallback if it finds nothing. ' +
  'If it is not (current events, prices, weather, or the user asked for the web), repeat the same call and it will run.'

/** The user asked for the open web themselves, so there is nothing to put ahead of it. */
const EXPLICIT_WEB = /\b(web|online|internet|google|bing|news|latest|current(ly)?|today|right now|search for)\b|https?:\/\//i

export function wantsWebExplicitly(request: string): boolean {
  return EXPLICIT_WEB.test(request)
}

/** True when an MCP Operator already ran in the current turn (a direct delegation or a plan step), i.e. the servers were tried. */
export function mcpAttemptedThisTurn(conversation: readonly Message[]): boolean {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const m = conversation[i]
    if (m.role === 'user' && m.content.some((b) => b.type === 'text' && !/^\[Plan step \d+ /.test(b.text))) return false
    for (const b of m.content) {
      if (b.type === 'tool_use' && /^delegate_to_mcp[-_]operator$/.test(b.name)) return true
      if (b.type === 'text' && (b.agentRole === 'mcp-operator' || /^\[Plan step \d+ — MCP Operator\]/.test(b.text))) return true
    }
  }
  return false
}
