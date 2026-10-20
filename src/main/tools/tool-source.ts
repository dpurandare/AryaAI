import type { Tool } from './types'

/**
 * TASKS #218: where a tool comes from, for the Auto-approve list in Settings: 'Built-in', 'Saved query' (a `db_query_*` tool
 * the user saved from a database call) or 'MCP server: <name>' (one row per tool of a connected server, named `mcp__<server>__<tool>`).
 */
export function toolSourceLabel(tool: Pick<Tool, 'name' | 'mcp'>): string {
  if (tool.mcp) return `MCP server: ${tool.mcp.server}`
  if (tool.name.startsWith('db_query_')) return 'Saved query'
  return 'Built-in'
}

/** Sort order of the sources: built-in first, saved queries next, MCP servers last. */
export function sourceRank(source: string): number {
  return source === 'Built-in' ? 0 : source === 'Saved query' ? 1 : 2
}
