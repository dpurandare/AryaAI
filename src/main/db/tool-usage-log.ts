import { randomUUID } from 'node:crypto'
import { getDb } from './index'

/** `agentRole` is the specialist's role id, or `router` for the top-level assistant's own calls. */
export interface ToolUseSample {
  tool: string
  agentRole: string
}

/** Called from the Orchestrator (via the optional `logToolUse` option, wired in ipc/register.ts) for every real tool call. Never throws — usage logging must not affect a turn. */
export function logToolUse(sample: ToolUseSample): void {
  try {
    getDb()
      .prepare('INSERT INTO tool_usage_log (id, tool_name, agent_role, created_at) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), sample.tool, sample.agentRole, Date.now())
  } catch {
    // best-effort
  }
}

export interface ToolUsageRow {
  tool: string
  calls: number
  /** Calls made by the router itself (not through a specialist) — the number that decides whether a tool belongs in the hot core. */
  routerCalls: number
}

/** Most-used first. `sinceMs` limits to calls at or after that time. */
export function getToolUsage(sinceMs = 0): ToolUsageRow[] {
  return getDb()
    .prepare(
      `SELECT tool_name AS tool, COUNT(*) AS calls, SUM(CASE WHEN agent_role = 'router' THEN 1 ELSE 0 END) AS routerCalls
       FROM tool_usage_log WHERE created_at >= ? GROUP BY tool_name ORDER BY calls DESC, tool_name ASC`
    )
    .all(sinceMs) as ToolUsageRow[]
}
