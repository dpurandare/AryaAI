import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '@shared/runtime'
import type { AgentRole } from '@shared/agents'
import { ToolRegistry } from '../tools/registry'
import type { Tool } from '../tools/types'
import type { Agent } from './orchestrator'
import { buildCapabilities, createDescribeCapabilitiesTool, type CapabilitiesInput } from './capabilities'

const tool = (name: string, mutates: Tool['mutates'] = false): Tool => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
  mutates,
  execute: async () => ''
})

function agent(role: AgentRole, tools: Tool[]): Agent {
  return { role, summary: `${role} summary`, systemPrompt: '', tools }
}

const shell = tool('shell_execute', true)
const sql = tool('db_execute_sql', () => true)
const read = tool('read_file')
const mcpA = tool('mcp__energy_wiki__search')
const mcpB = tool('mcp__energy_wiki__guide')

function input(over: Partial<CapabilitiesInput> = {}): CapabilitiesInput {
  const registry = new ToolRegistry()
  for (const t of [read, shell, sql, mcpA, mcpB]) registry.register(t)
  return {
    agents: new Map<AgentRole, Agent>([
      ['planning', agent('planning', [])],
      ['coding', agent('coding', [shell, mcpA, mcpB])],
      ['data', agent('data', [sql])]
    ]),
    registry,
    connections: { databases: [], apis: [], email: [] },
    runtime: { status: 'ready', packages: 'installed', message: 'ok', pythonVersion: '3.12.3', root: '/ws' },
    workspaceRoot: '/ws',
    ...over
  }
}

describe('buildCapabilities', () => {
  it('lists specialists with their real tools and says reasoning-only roles have none', () => {
    const text = buildCapabilities(input())
    expect(text).toMatch(/Planner \(delegate_to_planning\).*no tools \(reasoning only\)/)
    expect(text).toMatch(/Developer \(delegate_to_coding\).*Tools: shell_execute, plus 2 MCP tools/)
    expect(text).toMatch(/Data Access \(delegate_to_data\).*Tools: db_execute_sql/)
  })

  it('collapses MCP tools per server instead of listing every one', () => {
    const text = buildCapabilities(input())
    expect(text).toContain('MCP servers connected: energy_wiki (2 tools, named mcp__energy_wiki__*)')
    expect(text.split('## Tools you can call directly')[1].split('##')[0]).not.toContain('mcp__')
  })

  it('says plainly when nothing is configured, and what to do about it', () => {
    const text = buildCapabilities(input())
    expect(text).toMatch(/Databases: none configured.*Settings > Data sources/)
    expect(text).toMatch(/Email accounts: none configured/)
    expect(text).toContain('External APIs: none configured')
  })

  it('lists configured connections', () => {
    const text = buildCapabilities(
      input({
        connections: {
          databases: [{ name: 'Northwind', engine: 'sqlite' }],
          apis: [{ name: 'Weather', baseUrl: 'https://api.example.com' }],
          email: [{ name: 'Work', emailAddress: 'me@example.com', isDefault: true }]
        }
      })
    )
    expect(text).toContain('Northwind (sqlite)')
    expect(text).toContain('Weather (https://api.example.com)')
    expect(text).toContain('Work <me@example.com> [default]')
  })

  it('answers "can you run Python?" YES with the venv named, when the runtime is ready', () => {
    const text = buildCapabilities(input())
    expect(text).toMatch(/Python: AVAILABLE \(3\.12\.3\)/)
    expect(text).toContain('/ws/venv')
    expect(text).toMatch(/You CAN write a script and run it/)
  })

  it.each([
    ['disabled', 'Python: turned off by the user'],
    ['missing-python', 'Python: NOT available'],
    ['failed', 'Python: NOT available'],
    ['creating', 'being set up right now']
  ] as const)('reports the %s runtime state honestly', (status, expected) => {
    const runtime: RuntimeState = { status, packages: 'none', message: 'because reasons', root: '/ws' }
    expect(buildCapabilities(input({ runtime }))).toContain(expected)
  })

  it('does not claim Python is available when the runtime has not reported', () => {
    expect(buildCapabilities(input({ runtime: null }))).toContain('status not reported yet')
  })

  it('separates always-confirm tools from sometimes-confirm tools', () => {
    const text = buildCapabilities(input())
    expect(text).toContain('Asks the user to confirm before running: shell_execute.')
    expect(text).toContain('Asks only when the call would change something: db_execute_sql.')
  })

  it('states the shell is not a sandbox', () => {
    expect(buildCapabilities(input())).toMatch(/not a sandbox/)
  })
})

describe('describe_capabilities tool', () => {
  it('is read-only (no confirmation) and takes no arguments', () => {
    const t = createDescribeCapabilitiesTool({
      getAgents: () => new Map(),
      getRegistry: () => new ToolRegistry(),
      getConnections: () => ({ databases: [], apis: [], email: [] }),
      getRuntime: () => undefined
    })
    expect(t.name).toBe('describe_capabilities')
    expect(t.mutates).toBe(false)
    expect(t.inputSchema).toEqual({ type: 'object', properties: {} })
  })

  it('reads live state on every call, with the workspace root from the tool context', async () => {
    let runtime: RuntimeState = { status: 'creating', packages: 'none', message: '', root: '/w' }
    const t = createDescribeCapabilitiesTool({
      getAgents: () => new Map(),
      getRegistry: () => new ToolRegistry(),
      getConnections: () => ({ databases: [], apis: [], email: [] }),
      getRuntime: () => runtime
    })
    const ctx = { workspaceGuard: { root: '/w' }, currentSessionId: '' } as never
    expect(await t.execute({}, ctx)).toContain('being set up right now')
    runtime = { status: 'ready', packages: 'installed', message: '', pythonVersion: '3.11.0', root: '/w' }
    expect(await t.execute({}, ctx)).toContain('Python: AVAILABLE (3.11.0)')
    expect(await t.execute({}, ctx)).toContain('/w/venv')
  })
})
