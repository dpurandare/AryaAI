import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type SettingsExportPayload,
  type SettingsExportResult,
  type SettingsImportApplyResult,
  type SettingsImportPreviewItem,
  type SettingsImportPreviewResult
} from '@shared/ipc-contract'
import { getSetting, setSetting } from '../db/settings'
import type { ProviderRegistry } from '../providers/registry'
import { listServerConfigs, saveServerConfig } from '../mcp/config'
import { listConnections, saveConnection } from '../data/connections'

/**
 * TASKS.md #150 — shared by both the export-side reader and the router's
 * `tryResolveActiveProvider` (which needs the exact same key, so it's
 * exported here rather than duplicated).
 */
export const ACTIVE_PROVIDER_KEY = 'activeProviderId'
export const DEFAULT_PROVIDER_ID = 'openai'

export function modelSettingKey(providerId: string): string {
  return `model:${providerId}`
}

const FORMAT_VERSION = 1 as const
const DEFAULT_EXPORT_FILENAME = 'sachivji-settings-export.json'

export function buildSettingsExport(providerRegistry: Pick<ProviderRegistry, 'list'>): SettingsExportPayload {
  const models: Record<string, string> = {}
  for (const provider of providerRegistry.list()) {
    const model = getSetting(modelSettingKey(provider.id))
    if (model) models[provider.id] = model
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
      username: c.username
    }))
  }
}

export async function exportSettings(
  providerRegistry: Pick<ProviderRegistry, 'list'>,
  workspaceRoot: string,
  window: BrowserWindow | null
): Promise<SettingsExportResult> {
  const dialogOptions = {
    defaultPath: join(workspaceRoot, DEFAULT_EXPORT_FILENAME),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  }
  const { canceled, filePath } = window
    ? await dialog.showSaveDialog(window, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions)
  if (canceled || !filePath) return { cancelled: true }

  const payload = buildSettingsExport(providerRegistry)
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')
  return { cancelled: false, path: filePath }
}

function isSettingsExportPayload(value: unknown): value is SettingsExportPayload {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return v.formatVersion === FORMAT_VERSION && typeof v.providers === 'object' && Array.isArray(v.mcpServers) && Array.isArray(v.dataConnections)
}

/**
 * Diffs the parsed file against current local state to decide, per entry,
 * whether it's new (will be imported) or collides with something already
 * configured (skipped, flagged as a conflict) — computed once here and
 * reused unchanged by `applySettingsImport` below, so the preview the user
 * approves is exactly what gets applied, not a re-decided approximation.
 */
function buildPreviewItems(payload: SettingsExportPayload): SettingsImportPreviewItem[] {
  const items: SettingsImportPreviewItem[] = []

  const activeProviderAlreadySet = Boolean(getSetting(ACTIVE_PROVIDER_KEY))
  if (payload.providers.activeProviderId) {
    items.push({
      category: 'provider',
      label: `Active provider: ${payload.providers.activeProviderId}`,
      willImport: !activeProviderAlreadySet
    })
  }
  for (const [providerId, model] of Object.entries(payload.providers.models)) {
    items.push({
      category: 'provider',
      label: `${providerId} model: ${model}`,
      willImport: !getSetting(modelSettingKey(providerId))
    })
  }

  const existingServerNames = new Set(listServerConfigs().map((s) => s.name))
  for (const server of payload.mcpServers) {
    items.push({ category: 'mcpServer', label: server.name, willImport: !existingServerNames.has(server.name) })
  }

  const existingConnectionNames = new Set(listConnections().map((c) => c.name))
  for (const conn of payload.dataConnections) {
    items.push({ category: 'dataConnection', label: conn.name, willImport: !existingConnectionNames.has(conn.name) })
  }

  return items
}

export async function previewSettingsImport(window: BrowserWindow | null): Promise<SettingsImportPreviewResult> {
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

  return { cancelled: false, payload: parsed, items: buildPreviewItems(parsed) }
}

/** Re-derives the same willImport decisions `previewSettingsImport` already showed the user, then actually applies only those — never re-asks, never overwrites an existing entry. */
export function applySettingsImport(payload: SettingsExportPayload): SettingsImportApplyResult {
  let imported = 0
  let skipped = 0

  if (payload.providers.activeProviderId) {
    if (!getSetting(ACTIVE_PROVIDER_KEY)) {
      setSetting(ACTIVE_PROVIDER_KEY, payload.providers.activeProviderId)
      imported++
    } else {
      skipped++
    }
  }
  for (const [providerId, model] of Object.entries(payload.providers.models)) {
    if (!getSetting(modelSettingKey(providerId))) {
      setSetting(modelSettingKey(providerId), model)
      imported++
    } else {
      skipped++
    }
  }

  const existingServerNames = new Set(listServerConfigs().map((s) => s.name))
  for (const server of payload.mcpServers) {
    if (existingServerNames.has(server.name)) {
      skipped++
      continue
    }
    saveServerConfig(server)
    imported++
  }

  const existingConnectionNames = new Set(listConnections().map((c) => c.name))
  for (const conn of payload.dataConnections) {
    if (existingConnectionNames.has(conn.name)) {
      skipped++
      continue
    }
    saveConnection(conn)
    imported++
  }

  return { imported, skipped }
}
