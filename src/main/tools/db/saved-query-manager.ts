import type { SavedQueryDto } from '@shared/ipc-contract'
import { listSavedQueries } from '../../data/saved-queries'
import type { ToolRegistry } from '../registry'
import { buildSavedQueryTool, savedQueryToolName } from './saved-query-tools'

/**
 * Keeps the ToolRegistry in sync with saved queries — same shape as
 * McpManager (register live-generated tools into the same registry the
 * built-ins live in, track which registry entries came from which source
 * so they can be cleanly unregistered later), simpler here since there's
 * no connection lifecycle to manage: a saved query is just data, and its
 * tool is rebuilt fresh (openDriver() is only ever called inside the
 * tool's own execute()) whenever it changes.
 *
 * Tracks id -> current tool name so an *edit* (same id, possibly a new
 * name/sql/params — all of which change the generated tool name or shape)
 * correctly removes the old registry entry before adding the new one,
 * rather than leaving a stale tool behind under the old name.
 */
export class SavedQueryToolManager {
  private readonly toolNamesById = new Map<string, string>()

  syncAll(registry: ToolRegistry): void {
    for (const query of listSavedQueries()) this.register(query, registry)
  }

  register(query: SavedQueryDto, registry: ToolRegistry): void {
    this.unregister(query.id, registry)
    const tool = buildSavedQueryTool(query)
    registry.register(tool)
    this.toolNamesById.set(query.id, tool.name)
  }

  unregister(id: string, registry: ToolRegistry): void {
    const existingName = this.toolNamesById.get(id)
    if (existingName) registry.unregister(existingName)
    this.toolNamesById.delete(id)
  }
}

// Re-exported for callers that only need to compute a name without a live manager instance (e.g. tests).
export { savedQueryToolName }
