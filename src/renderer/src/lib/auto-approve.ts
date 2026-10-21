/**
 * TASKS #218: the pure rules behind Settings > Auto-approve rules and the confirmation gate, kept free of Svelte so they are unit-tested.
 */
import type { ToolDescriptor } from '@shared/ipc-contract'
import { isShellLikeTool } from '@shared/command-risk'

/** Folder access outside the workspace is its own confirmation request: never auto-approved, by the session blanket or by a per-tool rule. */
export const EXTERNAL_FOLDER_ACCESS = 'external_folder_access'

export function shouldAutoApprove(toolName: string, sessionBlanket: boolean, rules: Record<string, boolean>): boolean {
  if (toolName === EXTERNAL_FOLDER_ACCESS) return false
  // TASKS #234: a command or script is not limited to the workspace, so the confirmation is its only safeguard: the session-wide
  // switch never removes it. A per-tool rule is an explicit, named choice and still works.
  if (isShellLikeTool(toolName)) return rules[toolName] === true
  return sessionBlanket || rules[toolName] === true
}

/**
 * Stored rules that switch a tool on but name no tool the app has right now (a removed or renamed MCP server, or a server that is
 * disconnected at the moment). They stay stored and are listed so the user can remove them; nothing deletes them silently, because a
 * disconnected server's tools come back when it reconnects.
 */
export function staleRuleNames(rules: Record<string, boolean>, tools: readonly Pick<ToolDescriptor, 'name'>[]): string[] {
  const known = new Set(tools.map((t) => t.name))
  return Object.keys(rules)
    .filter((name) => rules[name] === true && !known.has(name))
    .sort()
}

const MAX_SUMMARY_CHARS = 120

/**
 * TASKS #233: the one-line description shown in the Auto-approve table. An MCP server's description is third-party text (up to 400
 * characters, already wrapped with an "untrusted metadata" prefix): the prefix is dropped, only the first sentence is kept, markup and
 * control characters are flattened, and the result is capped, so a server cannot fill the table with its own prose. Shown as plain text.
 */
export function toolSummary(description: string): string {
  const plain = description
    .replace(/^\[MCP server[^\]]*\]\s*/, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[`*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const sentenceEnd = plain.search(/[.!?](\s|$)/)
  const first = sentenceEnd >= 0 ? plain.slice(0, sentenceEnd + 1) : plain
  return first.length > MAX_SUMMARY_CHARS ? first.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd() + '…' : first
}

/** What the Refresh button reports: how many tools there are now and which names appeared or disappeared since the last read. */
export function refreshSummary(before: readonly Pick<ToolDescriptor, 'name'>[], after: readonly Pick<ToolDescriptor, 'name'>[]): string {
  const was = new Set(before.map((t) => t.name))
  const now = new Set(after.map((t) => t.name))
  const added = [...now].filter((n) => !was.has(n)).length
  const removed = [...was].filter((n) => !now.has(n)).length
  const count = `${after.length} tool${after.length === 1 ? '' : 's'}`
  if (!added && !removed) return `${count}, no changes`
  return `${count}: ${[added ? `${added} new` : '', removed ? `${removed} gone` : ''].filter(Boolean).join(', ')}`
}
