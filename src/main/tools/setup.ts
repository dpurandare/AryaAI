import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getSetting } from '../db/settings'
import { WorkspaceGuard } from '../security/workspace-guard'
import { apiCallTool, apiCheckStatusTool, apiIntrospectTool, apiListConnectionsTool } from './api'
import { awsCliTool, azureCliTool, gcloudCliTool } from './cloud-cli'
import {
  dbExecuteSqlTool,
  dbIntrospectSchemaTool,
  dbListConnectionsTool,
  dbListRowsTool,
  dbCountRowsTool,
  dbFindRowsTool,
  dbSaveQueryTool
} from './db'
import { listDirectoryTool, readFileTool, writeFileTool } from './file-ops'
import { gitCloneRepoTool, gitExecTool } from './git'
import { githubCliTool } from './github-cli'
import { ToolRegistry } from './registry'
import { shellExecuteTool } from './shell'
import type { ToolContext } from './types'
import { webSearchTool } from './web-search'
import { searchHistoryTool } from '../search-history/tool'

/** Settings key the persisted, user-configurable workspace root is stored under (TASKS.md #41). */
export const WORKSPACE_ROOT_SETTING_KEY = 'workspaceRoot'

/** Settings key for the classify-and-plan pre-pass toggle (see agents/orchestrator.ts's `classifyAndPlan`). Missing/unset reads as enabled — default on. */
export const PLANNING_ENABLED_SETTING_KEY = 'planningEnabled'

/** Fallback when the user hasn't configured a workspace root yet — a dedicated folder under Documents. */
export function defaultWorkspaceRoot(): string {
  return join(app.getPath('documents'), 'Sachiv Workspace')
}

/**
 * Workspace root file/shell/cloud-CLI/git tools are confined to. This is a
 * template reused as the shared base for every chat turn — `currentSessionId`
 * is always overridden per-turn (`{ ...toolContext, currentSessionId }` in
 * ipc/register.ts's runChat) since a session isn't known at app-startup
 * construction time; the empty-string placeholder here is never read directly.
 */
export function createToolContext(): ToolContext {
  const root = getSetting(WORKSPACE_ROOT_SETTING_KEY) || defaultWorkspaceRoot()
  mkdirSync(root, { recursive: true })
  return { workspaceGuard: new WorkspaceGuard(root), currentSessionId: '' }
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
  registry.register(dbListRowsTool)
  registry.register(dbCountRowsTool)
  registry.register(dbFindRowsTool)
  registry.register(dbSaveQueryTool)
  registry.register(webSearchTool)
  registry.register(gitExecTool)
  registry.register(gitCloneRepoTool)
  registry.register(githubCliTool)
  registry.register(searchHistoryTool)
  registry.register(apiListConnectionsTool)
  registry.register(apiIntrospectTool)
  registry.register(apiCallTool)
  registry.register(apiCheckStatusTool)
  return registry
}
