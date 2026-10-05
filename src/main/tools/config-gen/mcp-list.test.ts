import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockList = vi.fn()
vi.mock('../../mcp/config', () => ({ listServerConfigs: mockList }))

const { mcpListConnectionsTool } = await import('./mcp-list')

const ctx = (status: (id: string) => unknown) => ({ mcpServerStatus: status }) as never

describe('mcp_list_connections', () => {
  beforeEach(() => mockList.mockReset())

  it('says plainly when nothing is configured', async () => {
    mockList.mockReturnValue([])
    expect(await mcpListConnectionsTool.execute({}, ctx(() => undefined))).toMatch(/No MCP servers are configured/)
  })

  it('lists each server with its live state, including a failing one', async () => {
    mockList.mockReturnValue([
      { id: 'a', name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], description: 'Docs' },
      { id: 'b', name: 'wiki', transport: 'http', url: 'http://x' }
    ])
    const out = await mcpListConnectionsTool.execute(
      {},
      ctx((id) => (id === 'a' ? { status: 'connected', toolCount: 2 } : { status: 'error', error: 'refused', toolCount: 0 }))
    )
    expect(out).toContain('"context7" (stdio: npx -y @upstash/context7-mcp) — Docs: connected, 2 tools (named mcp__context7__*)')
    expect(out).toContain('"wiki" (http: http://x): NOT connected — refused')
  })

  it('reads the stored configs on every call, so a deletion shows immediately', async () => {
    mockList.mockReturnValueOnce([{ id: 'a', name: 'context7', transport: 'stdio', command: 'npx' }]).mockReturnValueOnce([])
    expect(await mcpListConnectionsTool.execute({}, ctx(() => undefined))).toContain('context7')
    expect(await mcpListConnectionsTool.execute({}, ctx(() => undefined))).toMatch(/No MCP servers/)
  })
})
