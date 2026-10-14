import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MCP_SERVER_DESCRIPTION_MAX } from '@shared/ipc-contract'

// mcp/config.ts imports the keychain (which imports electron) — same hazard and mock as mcp/config.test.ts.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
}))

const { setDbPath } = await import('../db')
const { listServerConfigs, normalizeServerDescription, saveServerConfig } = await import('./config')

describe('MCP server description (user-written, capped)', () => {
  beforeEach(() => {
    setDbPath(':memory:')
  })

  it('is stored trimmed with whitespace collapsed', () => {
    saveServerConfig({ name: 'wiki', transport: 'stdio', command: 'x', description: '  Energy   wiki:\nrunbooks  ' })
    expect(listServerConfigs()[0].description).toBe('Energy wiki: runbooks')
  })

  it(`is capped at ${MCP_SERVER_DESCRIPTION_MAX} characters, so nothing over the cap is ever stored`, () => {
    saveServerConfig({ name: 'wiki', transport: 'http', url: 'https://x', description: 'y'.repeat(1000) })
    expect(listServerConfigs()[0].description).toHaveLength(MCP_SERVER_DESCRIPTION_MAX)
  })

  it('empty or blank becomes absent, and editing without one clears it', () => {
    expect(normalizeServerDescription('   ')).toBeUndefined()
    expect(normalizeServerDescription(undefined)).toBeUndefined()
    const saved = saveServerConfig({ name: 'wiki', transport: 'stdio', command: 'x', description: 'first' })
    saveServerConfig({ id: saved.id, name: 'wiki', transport: 'stdio', command: 'x' })
    expect(listServerConfigs()[0].description).toBeUndefined()
  })
})
