import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { WorkspaceGuard } from '../security/workspace-guard'
import { listDirectoryTool, readFileTool, writeFileTool } from './file-ops'
import { ToolRegistry } from './registry'
import type { ToolContext } from './types'

/**
 * Workspace root file tools are confined to. Not yet user-configurable
 * (TASKS.md #41) — hardcoded to a dedicated folder under Documents.
 */
export function createToolContext(): ToolContext {
  const root = join(app.getPath('documents'), 'Sachiv Workspace')
  mkdirSync(root, { recursive: true })
  return { workspaceGuard: new WorkspaceGuard(root) }
}

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readFileTool)
  registry.register(listDirectoryTool)
  registry.register(writeFileTool)
  return registry
}
