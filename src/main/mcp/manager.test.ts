import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from '../tools/registry'
import type { Tool } from '../tools/types'
import type { McpServerConfig } from './config'

const mockConnectMcpServer = vi.fn()
const mockListServerConfigs = vi.fn()
const mockGetServerToken = vi.fn()

vi.mock('./client', () => ({ connectMcpServer: mockConnectMcpServer }))
vi.mock('./config', () => ({
  listServerConfigs: mockListServerConfigs,
  getServerToken: mockGetServerToken
}))

const { McpManager } = await import('./manager')

function fakeTool(name: string): Tool {
  return { name, description: '', inputSchema: {}, mutates: true, execute: async () => '' }
}

const closeSpy = vi.fn().mockResolvedValue(undefined)

const configA: McpServerConfig = { id: 'a', name: 'fs', transport: 'stdio', command: 'npx' }
const configB: McpServerConfig = { id: 'b', name: 'broken', transport: 'stdio', command: 'nope' }

describe('McpManager', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
    mockConnectMcpServer.mockReset()
    mockListServerConfigs.mockReset()
    mockGetServerToken.mockReset()
    closeSpy.mockClear()
  })

  it('connects every configured server and merges their tools into the registry', async () => {
    mockListServerConfigs.mockReturnValue([configA])
    mockConnectMcpServer.mockResolvedValue({
      client: { close: closeSpy },
      tools: [fakeTool('mcp__fs__read_file')]
    })

    const manager = new McpManager()
    await manager.connectAll(registry)

    expect(registry.get('mcp__fs__read_file')).toBeDefined()
    expect(manager.getStatus('a')).toEqual({ status: 'connected', error: undefined, toolCount: 1 })
  })

  it('a failed server records an error status and does not block a successful one in the same batch', async () => {
    mockListServerConfigs.mockReturnValue([configA, configB])
    mockConnectMcpServer.mockImplementation(async (config: McpServerConfig) => {
      if (config.id === 'b') throw new Error('spawn failed')
      return { client: { close: closeSpy }, tools: [fakeTool('mcp__fs__read_file')] }
    })

    const manager = new McpManager()
    await manager.connectAll(registry)

    expect(manager.getStatus('a')?.status).toBe('connected')
    expect(manager.getStatus('b')).toEqual({ status: 'error', error: 'spawn failed', toolCount: 0 })
    expect(registry.get('mcp__fs__read_file')).toBeDefined()
  })

  it('disconnect unregisters that server\'s tools and closes its client', async () => {
    mockListServerConfigs.mockReturnValue([configA])
    mockConnectMcpServer.mockResolvedValue({
      client: { close: closeSpy },
      tools: [fakeTool('mcp__fs__read_file'), fakeTool('mcp__fs__write_file')]
    })

    const manager = new McpManager()
    await manager.connectAll(registry)
    manager.disconnect('a', registry)

    expect(registry.get('mcp__fs__read_file')).toBeUndefined()
    expect(registry.get('mcp__fs__write_file')).toBeUndefined()
    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect(manager.getStatus('a')).toBeUndefined()
  })

  it('reconnect disconnects the old tools and registers the freshly discovered ones', async () => {
    mockListServerConfigs.mockReturnValue([configA])
    mockConnectMcpServer.mockResolvedValueOnce({
      client: { close: closeSpy },
      tools: [fakeTool('mcp__fs__old_tool')]
    })

    const manager = new McpManager()
    await manager.connectAll(registry)
    expect(registry.get('mcp__fs__old_tool')).toBeDefined()

    mockConnectMcpServer.mockResolvedValueOnce({
      client: { close: closeSpy },
      tools: [fakeTool('mcp__fs__new_tool')]
    })
    await manager.reconnect('a', registry)

    expect(registry.get('mcp__fs__old_tool')).toBeUndefined()
    expect(registry.get('mcp__fs__new_tool')).toBeDefined()
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('getStatus returns undefined for an unknown server', () => {
    expect(new McpManager().getStatus('nope')).toBeUndefined()
  })
})
