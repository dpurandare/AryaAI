import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const { saveConnection, saveSavedQuery, listConnections } = await import('../data/connections')
const { saveApiConnection, listApiConnections } = await import('../data/api-connections')
const { saveEmailConnection, listEmailConnections } = await import('../data/email-connections')
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
      expect(payload.formatVersion).toBe(2)
      expect(payload.providers.activeProviderId).toBe('ollama')
      expect(payload.providers.models).toEqual({ ollama: 'qwen3.5:9b-custom' })
      expect(payload.mcpServers).toEqual([
        { name: 'Context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], url: undefined, description: undefined }
      ])
      expect(payload.dataConnections).toEqual([
        { name: 'Northwind', engine: 'postgres', filePath: undefined, host: 'localhost', port: 5432, database: 'northwind', username: 'sa', savedQueries: [] }
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
      expect(JSON.parse(content as string).formatVersion).toBe(2)
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
      expect(result).toEqual({ imported: 4, skipped: 2, needsSecret: 1 }) // Northwind (postgres) still needs its password
      expect(getSetting(ACTIVE_PROVIDER_KEY)).toBe('ollama')
      expect(getSetting(modelSettingKey('ollama'))).toBe('already-here') // unchanged, not overwritten
      expect(getSetting(modelSettingKey('openai'))).toBe('gpt-4o-mini')
    })
  })
})

describe('settings import/export, format 2 (everything that is not a secret)', () => {
  let rolesDir: string
  beforeEach(() => {
    setDbPath(':memory:')
    userDataDir = mkdtempSync(join(tmpdir(), 'sachiv-settings-io2-'))
    rolesDir = join(userDataDir, 'roles')
    mockShowOpenDialog.mockReset()
    mockReadFile.mockReset()
  })
  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  function seedEverything(): void {
    const conn = saveConnection({ name: 'Northwind', engine: 'mssql', host: 'localhost', port: 1433, database: 'Northwind', username: 'sa', password: 'db-secret-1' })
    saveSavedQuery({ connectionId: conn.id, name: 'top_customers', description: 'Top customers', sql: 'SELECT TOP 5 * FROM Customers', params: [] })
    saveApiConnection({ name: 'Weather', baseUrl: 'https://api.open-meteo.com/', authType: 'none' })
    saveApiConnection({ name: 'Billing', baseUrl: 'https://billing.example.com', authType: 'apiKey', apiKeyHeader: 'apiKey', apiKeyIn: 'query', secret: 'api-secret-2' })
    saveEmailConnection({ name: 'Work', emailAddress: 'me@example.com', provider: 'gmail', appPassword: 'mail-secret-3' })
    setSetting('themeMode', 'dark')
    setSetting('temperature', '0.1')
    setSetting('zoomLevel', '1')
    setSetting('slimRouter', 'false')
    setSetting('sidebarWidth', '344') // layout: never exported
    setSetting('autoApproveToolRules', JSON.stringify({ download_image: true, shell_execute: false }))
    mkdirSync(rolesDir, { recursive: true })
    writeFileSync(join(rolesDir, 'reporter.md'), '---\nid: reporter\n---\nYou report.')
    writeFileSync(join(rolesDir, '_example-role.md'), 'never exported')
  }

  it('exports connections with their saved queries, API and email accounts, preferences, auto-approve rules and role files - and no secret', () => {
    seedEverything()
    const payload = buildSettingsExport(fakeRegistry, rolesDir)

    expect(payload.dataConnections[0].savedQueries).toEqual([{ name: 'top_customers', description: 'Top customers', sql: 'SELECT TOP 5 * FROM Customers', params: [] }])
    expect(payload.apiConnections?.map((a) => [a.name, a.baseUrl, a.authType, a.apiKeyHeader, a.apiKeyIn])).toEqual([
      ['Weather', 'https://api.open-meteo.com', 'none', undefined, undefined],
      ['Billing', 'https://billing.example.com', 'apiKey', 'apiKey', 'query']
    ])
    expect(payload.emailConnections).toEqual([{ name: 'Work', emailAddress: 'me@example.com', provider: 'gmail', host: undefined, port: undefined, secure: undefined }])
    expect(payload.preferences).toEqual({ themeMode: 'dark', temperature: '0.1', zoomLevel: '1', slimRouter: 'false' })
    expect(payload.autoApproveToolRules).toEqual({ download_image: true })
    expect(payload.roleFiles?.map((r) => r.fileName)).toEqual(['reporter.md'])

    const text = JSON.stringify(payload)
    for (const secret of ['db-secret-1', 'api-secret-2', 'mail-secret-3']) expect(text).not.toContain(secret)
    expect(text).not.toContain('sidebarWidth')
  })

  it('leaves a stored preference out of the export when its value is not one that setting can hold', () => {
    setSetting('themeMode', 'purple')
    setSetting('temperature', '7')
    setSetting('showTimestamps', 'true')
    expect(buildSettingsExport(fakeRegistry).preferences).toEqual({ showTimestamps: 'true' })
  })

  it('round-trips: an export from a full profile imports into an empty one, and notes what still needs a key', async () => {
    seedEverything()
    const payload = buildSettingsExport(fakeRegistry, rolesDir)

    setDbPath(':memory:') // a fresh profile
    const emptyRoles = join(userDataDir, 'roles-new')
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/x.json'] })
    mockReadFile.mockResolvedValue(JSON.stringify(payload))
    const preview = await previewSettingsImport(null, emptyRoles)
    if ('error' in preview || preview.cancelled) throw new Error('expected a preview')
    expect(preview.items.every((i) => i.willImport)).toBe(true)
    const note = (label: string): string | undefined => preview.items.find((i) => i.label.startsWith(label))?.note
    expect(note('Northwind')).toContain('password')
    expect(note('Northwind')).toContain('1 saved query')
    expect(note('Billing')).toContain('key')
    expect(note('Weather')).toBeUndefined()
    expect(note('Work')).toContain('app password')
    expect(note('download_image')).toContain('without asking')

    const result = applySettingsImport(payload, emptyRoles)
    expect(result.skipped).toBe(0)
    expect(result.needsSecret).toBe(3) // Northwind, Billing, Work
    expect(listConnections()[0].savedQueries.map((q) => q.name)).toEqual(['top_customers'])
    expect(listApiConnections().map((a) => a.name).sort()).toEqual(['Billing', 'Weather'])
    expect(listApiConnections().every((a) => !a.hasSecret)).toBe(true)
    expect(listApiConnections().find((a) => a.name === 'Billing')?.apiKeyIn).toBe('query') // where the key goes survives the round trip
    expect(listEmailConnections()[0].hasSecret).toBe(false)
    expect(getSetting('themeMode')).toBe('dark')
    expect(JSON.parse(getSetting('autoApproveToolRules') ?? '{}')).toEqual({ download_image: true })
    expect(readFileSync(join(emptyRoles, 'reporter.md'), 'utf-8')).toContain('You report.')
  })

  it('never overwrites: an existing preference, auto-approve rule, API connection or role file is skipped', () => {
    setSetting('themeMode', 'light')
    setSetting('autoApproveToolRules', JSON.stringify({ download_image: true }))
    saveApiConnection({ name: 'Weather', baseUrl: 'https://mine.example.com', authType: 'none' })
    mkdirSync(rolesDir, { recursive: true })
    writeFileSync(join(rolesDir, 'reporter.md'), 'mine')

    const result = applySettingsImport(
      {
        formatVersion: 2,
        exportedAt: 'x',
        providers: { models: {} },
        mcpServers: [],
        dataConnections: [],
        apiConnections: [{ name: 'Weather', baseUrl: 'https://theirs.example.com', authType: 'none' }],
        preferences: { themeMode: 'dark', zoomLevel: '2' },
        autoApproveToolRules: { download_image: true, read_file: true },
        roleFiles: [{ fileName: 'reporter.md', content: 'theirs' }]
      },
      rolesDir
    )
    expect(result).toEqual({ imported: 2, skipped: 4, needsSecret: 0 }) // zoomLevel and the read_file rule are new
    expect(getSetting('themeMode')).toBe('light')
    expect(getSetting('zoomLevel')).toBe('2')
    expect(JSON.parse(getSetting('autoApproveToolRules') ?? '{}')).toEqual({ download_image: true, read_file: true })
    expect(listApiConnections()[0].baseUrl).toBe('https://mine.example.com')
    expect(readFileSync(join(rolesDir, 'reporter.md'), 'utf-8')).toBe('mine')
  })

  it('ignores an imported preference that is not a known key or not a valid value', () => {
    const result = applySettingsImport(
      {
        formatVersion: 2,
        exportedAt: 'x',
        providers: { models: {} },
        mcpServers: [],
        dataConnections: [],
        preferences: { themeMode: 'purple', activeProviderId: 'evil', sidebarWidth: '1', temperature: '0.5' }
      },
      rolesDir
    )
    expect(result.imported).toBe(1)
    expect(getSetting('temperature')).toBe('0.5')
    expect(getSetting('themeMode')).toBeUndefined()
    expect(getSetting('sidebarWidth')).toBeUndefined()
  })

  it('writes a role file only inside the roles folder, whatever directory the file name carries', () => {
    applySettingsImport(
      {
        formatVersion: 2,
        exportedAt: 'x',
        providers: { models: {} },
        mcpServers: [],
        dataConnections: [],
        roleFiles: [
          { fileName: '../../escape.md', content: 'x' },
          { fileName: 'notes.txt', content: 'not a role' },
          { fileName: '_hidden.md', content: 'never loads' }
        ]
      },
      rolesDir
    )
    expect(existsSync(join(rolesDir, 'escape.md'))).toBe(true) // directory part dropped
    expect(existsSync(join(userDataDir, 'escape.md'))).toBe(false)
    expect(existsSync(join(rolesDir, 'notes.txt'))).toBe(false)
    expect(existsSync(join(rolesDir, '_hidden.md'))).toBe(false)
  })

  it('still imports a version-1 file (providers, MCP servers and connections only)', async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/v1.json'] })
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        formatVersion: 1,
        exportedAt: 'x',
        providers: { activeProviderId: 'ollama', models: {} },
        mcpServers: [{ name: 'wiki', transport: 'http', url: 'https://example.com/mcp' }],
        dataConnections: []
      })
    )
    const preview = await previewSettingsImport(null, rolesDir)
    if ('error' in preview || preview.cancelled) throw new Error('expected a preview')
    expect(preview.items.map((i) => i.label)).toEqual(['Active provider: ollama', 'wiki'])
  })
})
