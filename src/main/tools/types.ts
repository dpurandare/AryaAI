import type { WorkspaceGuard } from '../security/workspace-guard'

export interface ToolContext {
  workspaceGuard: WorkspaceGuard
  /** The session the current chat turn belongs to — used by search_history to exclude it from its own results (already in context). */
  currentSessionId: string
}

/**
 * A tool the model can call. `mutates: true` (or a function returning true
 * for the given input — needed by db_execute_sql, whose mutating-ness
 * depends on the actual SQL text per call) routes the call through the
 * human-in-loop confirmation flow in ipc/register.ts before `execute` runs.
 */
export interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mutates: boolean | ((input: Record<string, unknown>) => boolean)
  /** Human-readable summary shown in the confirmation dialog. Defaults to the raw input JSON. */
  describe?(input: Record<string, unknown>): string
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string>
}
