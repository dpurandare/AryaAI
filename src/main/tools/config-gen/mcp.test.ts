import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir: string
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, 'utf-8'),
    decryptString: (buf: Buffer) => buf.toString('utf-8')
  }
}))

const mockConnect = vi.fn()
const mockListTools = vi.fn()
const mockClose = vi.fn()
const FakeClient = vi.fn().mockImplementation(function FakeClient() {
  return { connect: mockConnect, listTools: mockListTools, close: mockClose }
})
const FakeStdioTransport = vi.fn().mockImplementation(function FakeStdioTransport(opts: unknown) {
  return { __kind: 'stdio', opts }
})
const FakeStreamableHttpTransport = vi
  .fn()
  .mockImplementation(function FakeStreamableHttpTransport(url: unknown, opts: unknown) {
    return { __kind: 'http', url, opts }
  })

vi.mock('@modelcontextprotocol/sdk/client', () => ({ Client: FakeClient }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: FakeStdioTransport,
  getDefaultEnvironment: () => ({ PATH: '/usr/bin' })
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: FakeStreamableHttpTransport
}))

const { setDbPath } = await import('../../db')
const { listServerConfigs } = await import('../../mcp/config')
const { mcpCreateConnectionTool } = await import('./mcp')

function makeCtx(): { connectMcpServer: ReturnType<typeof vi.fn> } {
  return { connectMcpServer: vi.fn().mockResolvedValue(undefined) }
}

describe('mcp_create_connection', () => {
  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-mcp-create-conn-'))
    mockConnect.mockReset().mockResolvedValue(undefined)
    mockListTools.mockReset().mockResolvedValue({ tools: [] })
    mockClose.mockReset().mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('always mutates, declares token as the secret field, and describes the target', () => {
    expect(mcpCreateConnectionTool.mutates).toBe(true)
    expect(mcpCreateConnectionTool.secretFields).toEqual(['token'])
    expect(mcpCreateConnectionTool.describe?.({ name: 'X', transport: 'stdio', command: 'npx' })).toBe(
      'Configure MCP server "X" (stdio) → npx'
    )
  })

  it('probes via a real handshake, closes the probe connection, then saves and live-reconnects', async () => {
    const input = { name: 'FS', transport: 'stdio', command: 'npx', args: ['-y', 'server-filesystem'] }
    const ctx = makeCtx()

    await expect(mcpCreateConnectionTool.validate?.(input, {} as never)).resolves.toBeUndefined()
    expect(mockConnect).toHaveBeenCalledTimes(1)
    expect(mockClose).toHaveBeenCalledTimes(1)

    const result = await mcpCreateConnectionTool.execute(input, ctx as never)
    expect(result).toMatch(/Configured and connected MCP server "FS"/)
    expect(listServerConfigs().some((s) => s.name === 'FS' && s.transport === 'stdio')).toBe(true)
    expect(ctx.connectMcpServer).toHaveBeenCalledWith(expect.any(String))
  })

  it('rejects a name collision without probing again, and does not call connectMcpServer', async () => {
    const ctx = makeCtx()
    await mcpCreateConnectionTool.execute({ name: 'Dup', transport: 'stdio', command: 'npx' }, ctx as never)
    ctx.connectMcpServer.mockClear()

    await expect(
      mcpCreateConnectionTool.execute({ name: 'Dup', transport: 'stdio', command: 'npx' }, ctx as never)
    ).rejects.toThrow(/already exists/)
    expect(ctx.connectMcpServer).not.toHaveBeenCalled()
  })

  it('rejects when the real handshake fails, and does not persist anything', async () => {
    mockConnect.mockRejectedValue(new Error('spawn ENOENT'))
    const input = { name: 'Broken', transport: 'stdio', command: 'nonexistent-binary' }

    await expect(mcpCreateConnectionTool.validate?.(input, {} as never)).rejects.toThrow('spawn ENOENT')
    await expect(mcpCreateConnectionTool.execute(input, makeCtx() as never)).rejects.toThrow('spawn ENOENT')
    expect(listServerConfigs().some((s) => s.name === 'Broken')).toBe(false)
  })
})
