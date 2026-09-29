import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// import-export.ts -> data/connections.ts/mcp/config.ts -> security/keychain.ts imports `electron` at
// module scope — same hazard documented in data/connections.test.ts/mcp/config.test.ts. import-export.ts
// itself also imports `dialog` and `node:fs/promises` (writeFile/readFile) directly, mocked here too so
// no test touches a real dialog or the real filesystem. Uses sync `node:fs` (a different module, never
// mocked) for the test's own tmp-dir setup instead of `node:fs/promises`, so mocking the latter for
// writeFile/readFile can't also swallow the unrelated mkdtemp/rm this file needs for itself.
let userDataDir: string
const mockShowSaveDialog = vi.fn()
const mockShowOpenDialog = vi.fn()
const mockWriteFile = vi.fn()
const mockReadFile = vi.fn()

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, 'utf-8'),
    decryptString: (buf: Buffer) => buf.toString('utf-8')
  },
  dialog: { showSaveDialog: mockShowSaveDialog, showOpenDialog: mockShowOpenDialog }
}))
vi.mock('node:fs/promises', () => ({ writeFile: mockWriteFile, readFile: mockReadFile }))

const { setDbPath } = await import('../db')
const { getSetting, setSetting } = await import('../db/settings')
const { saveServerConfig } = await import('../mcp/config')
const { saveConnection } = await import('../data/connections')
const { buildSettingsExport, exportSettings, previewSettingsImport, applySettingsImport, ACTIVE_PROVIDER_KEY, modelSettingKey } =
  await import('./import-export')
const fakeRegistry = { list: () => [{ id: 'openai' } as never, { id: 'ollama' } as never] }

describe('settings import/export (#150)', () => {
  beforeEach(() => {
    setDbPath(':memory:')
    userDataDir = mkdtempSync(join(tmpdir(), 'sachiv-settings-io-'))
    mockShowSaveDialog.mockReset()
    mockShowOpenDialog.mockReset()
    mockWriteFile.mockReset()
    mockReadFile.mockReset()
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  describe('buildSettingsExport', () => {
    it('includes only providers with a model actually selected, the active provider, and never a secret', () => {
      setSetting(ACTIVE_PROVIDER_KEY, 'ollama')
      setSetting(modelSettingKey('ollama'), 'qwen3.5:9b-custom')
      // openai has no model:openai setting — must not appear in models.
      saveServerConfig({ name: 'Context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] })
      saveConnection({ name: 'Northwind', engine: 'postgres', host: 'localhost', port: 5432, database: 'northwind', username: 'sa', password: 'super-secret' })

      const payload = buildSettingsExport(fakeRegistry)
      expect(payload.formatVersion).toBe(1)
      expect(payload.providers.activeProviderId).toBe('ollama')
      expect(payload.providers.models).toEqual({ ollama: 'qwen3.5:9b-custom' })
      expect(payload.mcpServers).toEqual([
        { name: 'Context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], url: undefined, description: undefined }
      ])
      expect(payload.dataConnections).toEqual([
        { name: 'Northwind', engine: 'postgres', filePath: undefined, host: 'localhost', port: 5432, database: 'northwind', username: 'sa' }
      ])
      // The password given to saveConnection above must never surface anywhere in the export.
      expect(JSON.stringify(payload)).not.toContain('super-secret')
    })
  })

  describe('exportSettings', () => {
    it('writes the built payload to the chosen path', async () => {
      mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/export.json' })
      const result = await exportSettings(fakeRegistry, '/workspace', null)
      expect(result).toEqual({ cancelled: false, path: '/tmp/export.json' })
      expect(mockWriteFile).toHaveBeenCalledTimes(1)
      const [path, content] = mockWriteFile.mock.calls[0]
      expect(path).toBe('/tmp/export.json')
      expect(JSON.parse(content as string).formatVersion).toBe(1)
    })

    it('returns cancelled without writing anything when the user dismisses the dialog', async () => {
      mockShowSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
      const result = await exportSettings(fakeRegistry, '/workspace', null)
      expect(result).toEqual({ cancelled: true })
      expect(mockWriteFile).not.toHaveBeenCalled()
    })
  })

  describe('previewSettingsImport', () => {
    it('flags an entry with the same name as an existing MCP server/connection as a skip, and a new one as an import', async () => {
      saveServerConfig({ name: 'Context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] })
      mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/import.json'] })
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          formatVersion: 1,
          exportedAt: '2026-09-29T00:00:00.000Z',
          providers: { activeProviderId: 'ollama', models: { ollama: 'qwen3.5:9b-custom' } },
          mcpServers: [
            { name: 'Context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
            { name: 'energy_wiki', transport: 'http', url: 'https://example.com/mcp' }
          ],
          dataConnections: [{ name: 'Northwind', engine: 'postgres', host: 'localhost', port: 5432, database: 'northwind', username: 'sa' }]
        })
      )

      const result = await previewSettingsImport(null)
      if ('error' in result || result.cancelled) throw new Error('expected a real preview')
      const byLabel = Object.fromEntries(result.items.map((i) => [i.label, i.willImport]))
      expect(byLabel['Context7']).toBe(false) // already configured locally
      expect(byLabel['energy_wiki']).toBe(true)
      expect(byLabel['Northwind']).toBe(true)
      expect(byLabel['Active provider: ollama']).toBe(true)
      expect(byLabel['ollama model: qwen3.5:9b-custom']).toBe(true)
    })

    it('rejects a file that is not a real settings export, without touching any state', async () => {
      mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/not-a-settings-file.json'] })
      mockReadFile.mockResolvedValue(JSON.stringify({ some: 'unrelated json' }))
      const result = await previewSettingsImport(null)
      expect('error' in result).toBe(true)
    })

    it('reports a JSON parse error plainly rather than throwing', async () => {
      mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/broken.json'] })
      mockReadFile.mockResolvedValue('{ not valid json')
      const result = await previewSettingsImport(null)
      expect('error' in result).toBe(true)
    })

    it('returns cancelled when the user dismisses the open dialog', async () => {
      mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
      const result = await previewSettingsImport(null)
      expect(result).toEqual({ cancelled: true })
    })
  })

  describe('applySettingsImport', () => {
    it('imports only the non-conflicting entries, skipping anything already configured, and never overwrites', () => {
      setSetting(modelSettingKey('ollama'), 'already-here')
      saveServerConfig({ name: 'Context7', transport: 'stdio', command: 'npx', args: ['old-args'] })

      const result = applySettingsImport({
        formatVersion: 1,
        exportedAt: '2026-09-29T00:00:00.000Z',
        providers: { activeProviderId: 'ollama', models: { ollama: 'new-model-should-be-skipped', openai: 'gpt-4o-mini' } },
        mcpServers: [
          { name: 'Context7', transport: 'stdio', command: 'npx', args: ['should-not-overwrite'] },
          { name: 'energy_wiki', transport: 'http', url: 'https://example.com/mcp' }
        ],
        dataConnections: [{ name: 'Northwind', engine: 'postgres', host: 'localhost', port: 5432, database: 'northwind', username: 'sa' }]
      })

      // activeProviderId (unset before) + openai model (unset before) + energy_wiki + Northwind = 4 imported.
      // ollama model (already set) + Context7 (already exists) = 2 skipped.
      expect(result).toEqual({ imported: 4, skipped: 2 })
      expect(getSetting(ACTIVE_PROVIDER_KEY)).toBe('ollama')
      expect(getSetting(modelSettingKey('ollama'))).toBe('already-here') // unchanged, not overwritten
      expect(getSetting(modelSettingKey('openai'))).toBe('gpt-4o-mini')
    })
  })
})
