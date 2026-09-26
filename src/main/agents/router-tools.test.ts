import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
}))

const { createDefaultRegistry } = await import('../tools/setup')
const { createAgents } = await import('./roles')
const { createDescribeCapabilitiesTool } = await import('./capabilities')
const { ROUTER_CORE_TOOLS, selectRouterTools } = await import('./router-tools')

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
