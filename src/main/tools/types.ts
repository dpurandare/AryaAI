import type pptxgen from 'pptxgenjs'
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
  /** Live-reconnects a freshly-saved MCP server (see mcp_create_connection in tools/config-gen/mcp.ts) so its tools appear immediately — same call the Settings > MCP servers save flow already makes. Optional/absent in tests, same reasoning as registerSavedQuery. */
  connectMcpServer?: (id: string) => Promise<void>
  /**
   * In-progress decks (#78), keyed by an id `pptx_start_deck` generates —
   * the only way state can survive across the top-level `pptx_add_slide`
   * calls and the several separate, fully-isolated `delegate_to_page-
   * creator` calls (each its own fresh conversation) that build up one
   * presentation together within a single turn. Fresh per turn (created
   * in ipc/register.ts's runChat, same lifetime as `registerSavedQuery`),
   * never persisted — `pptx_save_deck` is what turns it into a real file.
   * A plain `Map`, not a class, since nothing else needs to own behavior
   * around it. Optional/absent in tests that don't need deck tools.
   */
  activeDecks?: Map<string, { pres: pptxgen; slides: pptxgen.Slide[] }>
  /**
   * Live state of the workspace's managed Python runtime (`runtime/workspace-runtime.ts`), read by `python_run` so it can say
   * "Python is turned off" / "still being set up" instead of failing obscurely. Optional/absent in tests, where the tool falls
   * back to checking for the venv on disk.
   */
  runtimeState?: () => import('@shared/runtime').RuntimeState | undefined
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
  /** Input field names the confirmation dialog must render as real password inputs (kept out of the editable JSON textarea, never persisted into the tool_use content block) — see #74's config-generator tools. */
  secretFields?: string[]
  /**
   * Optional eager pre-flight check the confirmation dialog can call
   * repeatedly (same call, corrected input) before committing via
   * `execute` — lets a bad connection (wrong password, unreachable host)
   * be caught and retried in the same dialog instead of round-tripping
   * through a fresh model tool call. Throws with a user-facing message on
   * failure; must not persist anything (that's still `execute`'s job).
   */
  validate?(input: Record<string, unknown>, ctx: ToolContext): Promise<void>
  /**
   * `signal` fires when the user clicks Stop or this call runs past
   * `TOOL_EXECUTE_TIMEOUT_MS` (orchestrator.ts) — optional because most tools
   * (file writes, DB mutations via drivers with no native cancel, email,
   * deploy) have no way to actually stop mid-operation and can safely ignore
   * it; the orchestrator's own wait is bounded either way (see
   * `executeWithTimeout`), it just can't force-cancel the underlying work
   * for a tool that doesn't opt in. Set `cancellable: true` on a tool that
   * DOES react to it (see `shellExecuteTool`), so the timeout/stop message
   * shown to the model can honestly say "stopped" vs. "may still be running
   * in the background" for that specific tool.
   */
  execute(input: Record<string, unknown>, ctx: ToolContext, signal?: AbortSignal): Promise<string>
  /** True if `execute` actually honors `signal` to stop the underlying work, not just the orchestrator's wait on it. Defaults to false. */
  cancellable?: boolean
}
