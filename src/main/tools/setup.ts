import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { WorkspaceGuard } from '../security/workspace-guard'
import { awsCliTool, azureCliTool, gcloudCliTool } from './cloud-cli'
import { dbExecuteSqlTool, dbIntrospectSchemaTool, dbListConnectionsTool } from './db'
import { listDirectoryTool, readFileTool, writeFileTool } from './file-ops'
import { gitExecTool } from './git'
import { githubCliTool } from './github-cli'
import { ToolRegistry } from './registry'
import { shellExecuteTool } from './shell'
import type { ToolContext } from './types'
import { webSearchTool } from './web-search'

/**
 * Workspace root file/shell/cloud-CLI tools are confined to. Not yet
 * user-configurable (TASKS.md #41) — hardcoded to a dedicated folder under
 * Documents.
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
  registry.register(shellExecuteTool)
  registry.register(awsCliTool)
  registry.register(azureCliTool)
  registry.register(gcloudCliTool)
  registry.register(dbListConnectionsTool)
  registry.register(dbIntrospectSchemaTool)
  registry.register(dbExecuteSqlTool)
  registry.register(webSearchTool)
  registry.register(gitExecTool)
  registry.register(githubCliTool)
  return registry
}
