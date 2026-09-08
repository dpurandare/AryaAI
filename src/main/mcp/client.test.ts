import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from './config'

const mockConnect = vi.fn()
const mockListTools = vi.fn()
const mockCallTool = vi.fn()
const FakeClient = vi.fn().mockImplementation(function FakeClient() {
  return { connect: mockConnect, listTools: mockListTools, callTool: mockCallTool }
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

const { connectMcpServer } = await import('./client')

const stdioConfig: McpServerConfig = {
  id: 's1',
  name: 'fs',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'server-filesystem']
}

const httpConfig: McpServerConfig = { id: 's2', name: 'remote', transport: 'http', url: 'https://example.com/mcp' }

describe('connectMcpServer', () => {
  beforeEach(() => {
    FakeClient.mockClear()
    FakeStdioTransport.mockClear()
    FakeStreamableHttpTransport.mockClear()
    mockConnect.mockReset().mockResolvedValue(undefined)
    mockListTools.mockReset()
    mockCallTool.mockReset()
  })

  it('builds a StdioClientTransport with command/args for a stdio server', async () => {
    mockListTools.mockResolvedValue({ tools: [] })
    await connectMcpServer(stdioConfig, undefined)
    expect(FakeStdioTransport).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'npx', args: ['-y', 'server-filesystem'] })
    )
  })

  it('merges custom env onto the SDK default rather than replacing it', async () => {
    mockListTools.mockResolvedValue({ tools: [] })
    await connectMcpServer({ ...stdioConfig, env: { FOO: 'bar' } }, undefined)
    expect(FakeStdioTransport).toHaveBeenCalledWith(
      expect.objectContaining({ env: { PATH: '/usr/bin', FOO: 'bar' } })
    )
  })

  it('builds a StreamableHTTPClientTransport with a bearer header when a token is given', async () => {
    mockListTools.mockResolvedValue({ tools: [] })
    await connectMcpServer(httpConfig, 'secret-token')
    expect(FakeStreamableHttpTransport).toHaveBeenCalledWith(
      new URL('https://example.com/mcp'),
      expect.objectContaining({ requestInit: { headers: { Authorization: 'Bearer secret-token' } } })
    )
  })

  it('omits requestInit headers when no token is given', async () => {
    mockListTools.mockResolvedValue({ tools: [] })
    await connectMcpServer(httpConfig, undefined)
    expect(FakeStreamableHttpTransport).toHaveBeenCalledWith(
      new URL('https://example.com/mcp'),
      expect.objectContaining({ requestInit: undefined })
    )
  })

  it('namespaces discovered tool names by server name', async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: 'read_file', description: 'reads a file', inputSchema: { type: 'object' } }]
    })
    const { tools } = await connectMcpServer(stdioConfig, undefined)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('mcp__fs__read_file')
    expect(tools[0].description).toBe('reads a file')
  })

  it('treats readOnlyHint: true as non-mutating and everything else as mutating', async () => {
    mockListTools.mockResolvedValue({
      tools: [
        { name: 'read', inputSchema: {}, annotations: { readOnlyHint: true } },
        { name: 'write', inputSchema: {}, annotations: { readOnlyHint: false } },
        { name: 'unknown', inputSchema: {} }
      ]
    })
    const { tools } = await connectMcpServer(stdioConfig, undefined)
    expect(tools.find((t) => t.name.endsWith('read'))?.mutates).toBe(false)
    expect(tools.find((t) => t.name.endsWith('write'))?.mutates).toBe(true)
    expect(tools.find((t) => t.name.endsWith('unknown'))?.mutates).toBe(true)
  })

  it('execute() joins text content blocks and summarizes non-text ones', async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: 'search', inputSchema: {} }] })
    const { tools } = await connectMcpServer(stdioConfig, undefined)
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'first' }, { type: 'image', data: 'x' }, { type: 'text', text: 'second' }]
    })

    const result = await tools[0].execute({ q: 'x' }, {} as never)
    expect(result).toBe('first\n[image content omitted]\nsecond')
    expect(mockCallTool).toHaveBeenCalledWith({ name: 'search', arguments: { q: 'x' } })
  })

  it('execute() throws when the result is an error', async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: 'search', inputSchema: {} }] })
    const { tools } = await connectMcpServer(stdioConfig, undefined)
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'boom' }], isError: true })

    await expect(tools[0].execute({}, {} as never)).rejects.toThrow('boom')
  })
})
