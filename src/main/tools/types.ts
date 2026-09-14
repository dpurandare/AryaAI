import type { SavedQueryDto } from '@shared/ipc-contract'
import type { WorkspaceGuard } from '../security/workspace-guard'

export interface ToolContext {
  workspaceGuard: WorkspaceGuard
  /** The session the current chat turn belongs to. No current tool reads this (search_history stopped excluding the active session — see its own doc comment), but it's real per-turn context a future tool may reasonably need. */
  currentSessionId: string
  /**
   * Live-registers a freshly-saved query's tool into the app's own
   * ToolRegistry (see tools/db/saved-query-manager.ts) — only db_save_query
   * calls this. Optional/absent in tests, which build a bare ToolRegistry
   * with no live wiring to a running app.
   */
  registerSavedQuery?: (query: SavedQueryDto) => void
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
