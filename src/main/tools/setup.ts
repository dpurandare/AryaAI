import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getSetting } from '../db/settings'
import { WorkspaceGuard } from '../security/workspace-guard'
import { apiCallTool, apiCheckStatusTool, apiIntrospectTool, apiListConnectionsTool } from './api'
import { awsCliTool, azureCliTool, gcloudCliTool } from './cloud-cli'
import { apiCreateConnectionTool, dbCreateConnectionTool, mcpCreateConnectionTool, mcpListConnectionsTool } from './config-gen'
import { pptxAddSlideTool, pptxComposeSlideTool, pptxSaveDeckTool, pptxStartDeckTool } from './deck'
import { listEmailConnectionsTool, sendEmailTool } from './email'
import { parseCsvTool, parseHtmlTool, parseJsonTool, parseXmlTool } from './data-formats'
import { externalAccess } from '../security/external-access-store'
import { downloadImageTool } from './download-image'
import { findStockImagesTool } from './stock-images'
import { readResearchNotesTool, saveResearchNoteTool } from './research-notes'
import { showMediaTool } from './show-media'
import {
  dbExecuteSqlTool,
  dbIntrospectSchemaTool,
  dbListConnectionsTool,
  dbListRowsTool,
  dbCountRowsTool,
  dbFindRowsTool,
  dbSaveQueryTool
} from './db'
import { findFilesTool } from './find-files'
import { listDirectoryTool, readFileTool, writeFileTool } from './file-ops'
import { gitCloneRepoTool, gitExecTool } from './git'
import { githubCliTool } from './github-cli'
import {
  officeCreateDocumentTool,
  officeExtractTemplateTool,
  officeFillTemplateTool,
  officeReadDocumentTool,
  xlsxReadTool,
  xlsxWriteTool
} from './office-docs'
import { ToolRegistry } from './registry'
import { pythonRunTool } from './python-run'
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
  return join(app.getPath('documents'), 'Sachivji Workspace')
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
  return { workspaceGuard: new WorkspaceGuard(root), currentSessionId: '', externalAccess }
}

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readFileTool)
  registry.register(listDirectoryTool)
  registry.register(findFilesTool)
  registry.register(writeFileTool)
  registry.register(shellExecuteTool)
  registry.register(pythonRunTool)
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
  registry.register(parseHtmlTool)
  registry.register(parseCsvTool)
  registry.register(parseJsonTool)
  registry.register(parseXmlTool)
  registry.register(officeReadDocumentTool)
  registry.register(officeCreateDocumentTool)
  registry.register(officeFillTemplateTool)
  registry.register(officeExtractTemplateTool)
  registry.register(xlsxReadTool)
  registry.register(xlsxWriteTool)
  registry.register(dbCreateConnectionTool)
  registry.register(apiCreateConnectionTool)
  registry.register(mcpCreateConnectionTool)
  registry.register(mcpListConnectionsTool)
  registry.register(pptxStartDeckTool)
  registry.register(pptxAddSlideTool)
  registry.register(pptxComposeSlideTool)
  registry.register(pptxSaveDeckTool)
  registry.register(listEmailConnectionsTool)
  registry.register(sendEmailTool)
  registry.register(showMediaTool)
  registry.register(downloadImageTool)
  registry.register(findStockImagesTool)
  registry.register(saveResearchNoteTool)
  registry.register(readResearchNotesTool)
  return registry
}
