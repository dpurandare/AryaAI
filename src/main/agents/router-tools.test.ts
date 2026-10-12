import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
}))

const { createDefaultRegistry } = await import('../tools/setup')
const { createAgents } = await import('./roles')
const { createDescribeCapabilitiesTool } = await import('./capabilities')
const { ROUTER_CORE_TOOLS, fullRouterTools, selectRouterTools, withoutMcpTools } = await import('./router-tools')

function setup() {
  const registry = createDefaultRegistry()
  const agents = createAgents(registry)
  registry.register(
    createDescribeCapabilitiesTool({
      getAgents: () => agents,
      getRegistry: () => registry,
      getConnections: () => ({ databases: [], apis: [], email: [] }),
      getRuntime: () => undefined
    })
  )
  return { registry, agents }
}

describe('selectRouterTools (slim router)', () => {
  const { registry, agents } = setup()
  const names = selectRouterTools(registry.list(), agents).map((t) => t.name)

  it('carries the whole hot core', () => {
    for (const core of ROUTER_CORE_TOOLS) expect(names, `core tool ${core}`).toContain(core)
  })

  it('keeps the deck-building tools — no specialist owns them, so dropping them would remove PowerPoint building', () => {
    expect(names).toEqual(expect.arrayContaining(['pptx_start_deck', 'pptx_add_slide', 'pptx_save_deck']))
  })

  it('drops everything a specialist owns that is not core: SQL, Office, parsing, email, cloud CLIs, python_run, connections', () => {
    for (const gone of ['db_execute_sql', 'db_list_connections', 'api_call', 'parse_csv', 'xlsx_write', 'office_create_document', 'send_email', 'aws_cli', 'python_run', 'git_exec', 'search_history', 'db_create_connection']) {
      expect(names, gone).not.toContain(gone)
    }
  })

  it('drops MCP tools too — they belong to the MCP Operator, so a huge server adds nothing to the router', () => {
    const many = Array.from({ length: 144 }, (_, i) => ({ ...registry.get('read_file')!, name: `mcp__gbrain__tool_${i}`, mcp: { server: 'gbrain' } }))
    const withMcp = [...registry.list(), ...many]
    const slim = selectRouterTools(withMcp, agents).map((t) => t.name)
    expect(slim.some((n) => n.startsWith('mcp__'))).toBe(false)
    expect(slim).toEqual(names) // byte-for-byte the same router with or without the server
  })

  it('the core is small and every core tool really exists in the registry (no stale entries)', () => {
    expect(ROUTER_CORE_TOOLS.length).toBeLessThanOrEqual(8)
    for (const core of ROUTER_CORE_TOOLS) expect(registry.get(core), core).toBeDefined()
  })

  it('every specialist-owned tool remains reachable: it is either in the router or owned by some specialist', () => {
    const carried = new Set(names)
    const owned = new Set([...agents.values()].flatMap((a) => a.tools.map((t) => t.name)))
    for (const t of registry.list()) expect(carried.has(t.name) || owned.has(t.name), `${t.name} is unreachable`).toBe(true)
    // MCP tools are reachable through the operator once a server is connected.
    const withMcp = [{ ...registry.get('read_file')!, name: 'mcp__wiki__x' }]
    const ag = createAgents({ list: () => withMcp, get: (n: string) => withMcp.find((t) => t.name === n) } as never)
    expect(ag.get('mcp-operator')?.tools.map((t) => t.name)).toEqual(['mcp__wiki__x'])
  })
})

describe('withoutMcpTools (full router)', () => {
  it('drops every connected server\'s tools so the router can only reach a wiki by delegating to the MCP Operator, and keeps everything else', () => {
    const { registry } = setup()
    const mcp = (name: string) => ({ name, description: name, inputSchema: { type: 'object' as const, properties: {} }, mutates: false, execute: async () => '' })
    registry.register(mcp('mcp__llmwiki-docs__search'))
    registry.register(mcp('mcp__context7__query_docs'))
    const all = registry.list()
    const kept = withoutMcpTools(all).map((t) => t.name)
    expect(kept.some((n) => n.startsWith('mcp__'))).toBe(false)
    expect(kept.length).toBe(all.length - 2)
    expect(kept).toEqual(expect.arrayContaining(['db_execute_sql', 'shell_execute', 'web_search']))
  })
})

describe('fullRouterTools', () => {
  it('also hides the tools only a specialist uses (research notes), keeping the picture tools the deck flow needs', () => {
    const { registry } = setup()
    const names = fullRouterTools(registry.list()).map((t) => t.name)
    expect(names).not.toContain('save_research_note')
    expect(names).not.toContain('read_research_notes')
    expect(names).toEqual(expect.arrayContaining(['find_stock_images', 'download_image', 'pptx_start_deck', 'web_search']))
  })

  it('drops the Configurator\'s connection-setup tools too (TASKS.md #202: live-reproduced with gpt-4o-mini and gpt-4o retrying mcp_create_connection instead of delegating), but keeps mcp_list_connections since it is core', () => {
    const { registry } = setup()
    const names = fullRouterTools(registry.list()).map((t) => t.name)
    for (const gone of ['mcp_create_connection', 'db_create_connection', 'api_create_connection']) {
      expect(names, gone).not.toContain(gone)
    }
    expect(names).toContain('mcp_list_connections')
  })
})
