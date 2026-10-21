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
