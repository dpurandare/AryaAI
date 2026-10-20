import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type SettingsExportPayload,
  type SettingsExportResult,
  type SettingsImportApplyResult,
  type SettingsImportPreviewItem,
  type SettingsImportPreviewResult
} from '@shared/ipc-contract'
import { getSetting, setSetting } from '../db/settings'
import { EXPORTS_DIR } from '../tools/workspace-layout'
import type { ProviderRegistry } from '../providers/registry'
import { listServerConfigs, saveServerConfig } from '../mcp/config'
import { listConnections, saveConnection, saveSavedQuery } from '../data/connections'
import { listApiConnections, saveApiConnection } from '../data/api-connections'
import { listEmailConnections, saveEmailConnection } from '../data/email-connections'
import { readRoleFiles, roleFileExists, safeRoleFileName, writeRoleFile } from './role-files'

/**
 * TASKS.md #150 — shared by both the export-side reader and the router's
 * `tryResolveActiveProvider` (which needs the exact same key, so it's
 * exported here rather than duplicated).
 */
export const ACTIVE_PROVIDER_KEY = 'activeProviderId'
export const DEFAULT_PROVIDER_ID = 'openai'

/**
 * The scalar settings a settings export carries (stored strings, copied as they are). Left out on purpose: window/pane sizes and the
 * composer height (per-machine layout), `onboardingCompleted`, and everything that is a secret (those never reach the settings table).
 * Duplicated here as plain strings because the modules that own these keys import Electron and would make a cycle.
 */
export const PREFERENCE_KEYS: readonly string[] = [
  'themeMode',
  'temperature',
  'planningEnabled',
  'slimRouter',
  'promptCaching',
  'showTimestamps',
  'showAnsweringModel',
  'toolDisplayMode',
  'toolDetailsExpanded',
  'zoomLevel',
  'embeddingModel',
  'disabledRoles'
]
export const AUTO_APPROVE_RULES_KEY = 'autoApproveToolRules'

function readAutoApproveRules(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(getSetting(AUTO_APPROVE_RULES_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => v === true)) as Record<string, boolean>
  } catch {
    return {}
  }
}

export function modelSettingKey(providerId: string): string {
  return `model:${providerId}`
}

const FORMAT_VERSION = 2 as const
const ACCEPTED_FORMAT_VERSIONS: readonly number[] = [1, 2]
const DEFAULT_EXPORT_FILENAME = 'sachivji-settings-export.json'

/** A stored preference is only exported and imported if it is a value that setting can really hold; anything else is left out. */
export function isValidPreference(key: string, value: unknown): value is string {
  if (typeof value !== 'string') return false
  const bool = value === 'true' || value === 'false'
  switch (key) {
    case 'themeMode':
      return value === 'light' || value === 'dark' || value === 'system'
    case 'toolDisplayMode':
      return value === 'hidden' || value === 'partial' || value === 'shown'
    case 'temperature': {
      const n = Number(value)
      return value.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 1
    }
    case 'zoomLevel': {
      const n = Number(value)
      return value.trim() !== '' && Number.isFinite(n) && n >= -3 && n <= 5
    }
    case 'embeddingModel':
      return value.length > 0 && value.length <= 200
    case 'disabledRoles':
      try {
        const parsed: unknown = JSON.parse(value)
        return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')
      } catch {
        return false
      }
    default:
      return PREFERENCE_KEYS.includes(key) && bool
  }
}

export function buildSettingsExport(
  providerRegistry: Pick<ProviderRegistry, 'list'>,
  rolesFolder?: string
): SettingsExportPayload {
  const models: Record<string, string> = {}
  for (const provider of providerRegistry.list()) {
    const model = getSetting(modelSettingKey(provider.id))
    if (model) models[provider.id] = model
  }

  const preferences: Record<string, string> = {}
  for (const key of PREFERENCE_KEYS) {
    const value = getSetting(key)
    if (isValidPreference(key, value)) preferences[key] = value
  }

  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    providers: {
      activeProviderId: getSetting(ACTIVE_PROVIDER_KEY),
      models
    },
    mcpServers: listServerConfigs().map((s) => ({
      name: s.name,
      transport: s.transport,
      command: s.command,
      args: s.args,
      url: s.url,
      description: s.description
    })),
    dataConnections: listConnections().map((c) => ({
      name: c.name,
      engine: c.engine,
      filePath: c.filePath,
      host: c.host,
      port: c.port,
      database: c.database,
      username: c.username,
      savedQueries: (c.savedQueries ?? []).map((q) => ({ name: q.name, description: q.description, sql: q.sql, params: q.params }))
    })),
    apiConnections: listApiConnections().map((c) => ({
      name: c.name,
      baseUrl: c.baseUrl,
      authType: c.authType,
      apiKeyHeader: c.apiKeyHeader,
      apiKeyIn: c.apiKeyIn,
      username: c.username,
      specUrl: c.specUrl
    })),
    emailConnections: listEmailConnections().map((c) => ({
      name: c.name,
      emailAddress: c.emailAddress,
      provider: c.provider,
      host: c.host,
      port: c.port,
      secure: c.secure
    })),
    preferences,
    autoApproveToolRules: readAutoApproveRules(),
    roleFiles: rolesFolder ? readRoleFiles(rolesFolder) : []
  }
}

export async function exportSettings(
  providerRegistry: Pick<ProviderRegistry, 'list'>,
  workspaceRoot: string,
  window: BrowserWindow | null,
  rolesFolder?: string
): Promise<SettingsExportResult> {
  // TASKS #204: exports open in the workspace's exports/ folder, not the root (created if missing; best-effort, the dialog still works without it).
  const exportsDir = join(workspaceRoot, EXPORTS_DIR)
  await mkdir(exportsDir, { recursive: true }).catch(() => undefined)
  const dialogOptions = {
    defaultPath: join(exportsDir, DEFAULT_EXPORT_FILENAME),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  }
  const { canceled, filePath } = window
    ? await dialog.showSaveDialog(window, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions)
  if (canceled || !filePath) return { cancelled: true }

  const payload = buildSettingsExport(providerRegistry, rolesFolder)
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')
  return { cancelled: false, path: filePath }
}

function isSettingsExportPayload(value: unknown): value is SettingsExportPayload {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.formatVersion === 'number' &&
    ACCEPTED_FORMAT_VERSIONS.includes(v.formatVersion) &&
    typeof v.providers === 'object' &&
    Array.isArray(v.mcpServers) &&
    Array.isArray(v.dataConnections)
  )
}

const NEEDS_PASSWORD = 'needs its password entered in Settings'
const NEEDS_KEY = 'needs its key entered in Settings'

/** One decision per entry, computed in one place and used by both the preview and the apply step, so the preview the user approves is exactly what gets applied. */
interface ImportPlan {
  items: SettingsImportPreviewItem[]
  /** Runs the import for the entries that will import; returns how many were imported and how many of those still need a secret. */
  apply: () => { imported: number; needsSecret: number }
}

function planImport(payload: SettingsExportPayload, rolesFolder?: string): ImportPlan {
  const items: SettingsImportPreviewItem[] = []
  const actions: Array<() => boolean> = [] // returns true if the entry still needs a secret
  const add = (item: SettingsImportPreviewItem, run: () => boolean): void => {
    items.push(item)
    if (item.willImport) actions.push(run)
  }

  const activeProviderAlreadySet = Boolean(getSetting(ACTIVE_PROVIDER_KEY))
  const activeProviderId = payload.providers.activeProviderId
  if (activeProviderId) {
    add(
      { category: 'provider', label: `Active provider: ${activeProviderId}`, willImport: !activeProviderAlreadySet },
      () => {
        setSetting(ACTIVE_PROVIDER_KEY, activeProviderId)
        return false
      }
    )
  }
  for (const [providerId, model] of Object.entries(payload.providers.models ?? {})) {
    add({ category: 'provider', label: `${providerId} model: ${model}`, willImport: !getSetting(modelSettingKey(providerId)) }, () => {
      setSetting(modelSettingKey(providerId), model)
      return false
    })
  }

  const existingServerNames = new Set(listServerConfigs().map((s) => s.name))
  for (const server of payload.mcpServers) {
    add(
      {
        category: 'mcpServer',
        label: server.name,
        willImport: !existingServerNames.has(server.name),
        note: server.transport === 'http' ? 'a bearer token, if it uses one, is not in the file' : undefined
      },
      () => {
        saveServerConfig(server)
        return false
      }
    )
  }

  const existingConnectionNames = new Set(listConnections().map((c) => c.name))
  for (const conn of payload.dataConnections) {
    const queryCount = conn.savedQueries?.length ?? 0
    const notes = [conn.engine !== 'sqlite' ? NEEDS_PASSWORD : '', queryCount ? `${queryCount} saved quer${queryCount === 1 ? 'y' : 'ies'}` : '']
    add(
      {
        category: 'dataConnection',
        label: conn.name,
        willImport: !existingConnectionNames.has(conn.name),
        note: notes.filter(Boolean).join('; ') || undefined
      },
      () => {
        const { savedQueries, ...connection } = conn
        const saved = saveConnection(connection)
        for (const q of savedQueries ?? []) {
          try {
            saveSavedQuery({ connectionId: saved.id, name: q.name, description: q.description, sql: q.sql, params: q.params })
          } catch {
            // a saved query that no longer validates is left out; the connection itself is still imported
          }
        }
        return conn.engine !== 'sqlite'
      }
    )
  }

  const existingApiNames = new Set(listApiConnections().map((c) => c.name))
  for (const api of payload.apiConnections ?? []) {
    add(
      {
        category: 'apiConnection',
        label: api.name,
        willImport: !existingApiNames.has(api.name),
        note: api.authType !== 'none' ? NEEDS_KEY : undefined
      },
      () => {
        saveApiConnection(api)
        return api.authType !== 'none'
      }
    )
  }

  const existingEmailNames = new Set(listEmailConnections().map((c) => c.name))
  for (const mail of payload.emailConnections ?? []) {
    add(
      { category: 'emailConnection', label: `${mail.name} <${mail.emailAddress}>`, willImport: !existingEmailNames.has(mail.name), note: 'needs its app password entered in Settings' },
      () => {
        saveEmailConnection(mail)
        return true
      }
    )
  }

  for (const [key, value] of Object.entries(payload.preferences ?? {})) {
    if (!PREFERENCE_KEYS.includes(key) || !isValidPreference(key, value)) continue
    add({ category: 'preference', label: `${key} = ${value}`, willImport: getSetting(key) === undefined }, () => {
      setSetting(key, value)
      return false
    })
  }

  const existingRules = readAutoApproveRules()
  const newRules: Record<string, boolean> = {}
  for (const [tool, allowed] of Object.entries(payload.autoApproveToolRules ?? {})) {
    if (allowed !== true) continue
    const isNew = existingRules[tool] !== true
    add({ category: 'autoApprove', label: tool, willImport: isNew, note: isNew ? 'this tool will run without asking' : undefined }, () => {
      newRules[tool] = true
      return false
    })
  }

  if (rolesFolder) {
    for (const role of payload.roleFiles ?? []) {
      const fileName = safeRoleFileName(role.fileName)
      if (!fileName || typeof role.content !== 'string') continue
      add(
        { category: 'role', label: fileName, willImport: !roleFileExists(rolesFolder, fileName), note: 'adds an agent with the tools its file lists' },
        () => {
          writeRoleFile(rolesFolder, fileName, role.content)
          return false
        }
      )
    }
  }

  return {
    items,
    apply: () => {
      let imported = 0
      let needsSecret = 0
      for (const run of actions) {
        if (run()) needsSecret++
        imported++
      }
      if (Object.keys(newRules).length > 0) setSetting(AUTO_APPROVE_RULES_KEY, JSON.stringify({ ...readAutoApproveRules(), ...newRules }))
      return { imported, needsSecret }
    }
  }
}

export async function previewSettingsImport(window: BrowserWindow | null, rolesFolder?: string): Promise<SettingsImportPreviewResult> {
  const dialogOptions = { filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile' as const] }
  const { canceled, filePaths } = window
    ? await dialog.showOpenDialog(window, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)
  if (canceled || filePaths.length === 0) return { cancelled: true }

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filePaths[0], 'utf-8'))
  } catch {
    return { error: `"${filePaths[0]}" is not valid JSON.` }
  }
  if (!isSettingsExportPayload(parsed)) {
    return { error: `"${filePaths[0]}" doesn't look like a Sachivji settings export.` }
  }

  return { cancelled: false, payload: parsed, items: planImport(parsed, rolesFolder).items }
}

/** Re-derives the same willImport decisions `previewSettingsImport` already showed the user, then actually applies only those — never re-asks, never overwrites an existing entry. */
export function applySettingsImport(payload: SettingsExportPayload, rolesFolder?: string): SettingsImportApplyResult {
  const plan = planImport(payload, rolesFolder)
  const { imported, needsSecret } = plan.apply()
  return { imported, skipped: plan.items.length - imported, needsSecret }
}
