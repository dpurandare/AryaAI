import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../tools/registry'
import type { Tool } from '../tools/types'
import { createAgents } from './roles'

function fakeTool(name: string): Tool {
  return { name, description: 'test', inputSchema: { type: 'object', properties: {} }, mutates: false, execute: async () => '' }
}

describe('createAgents', () => {
  it('a tool registered AFTER createAgents() is still visible to a delegated specialist, not just the top-level orchestrator', () => {
    // Regression test: agent.tools used to be a plain array snapshotted
    // once at createAgents() call time — a tool added to the registry
    // later (an MCP server connecting, a saved query being created from
    // Settings) was reachable from the top-level orchestrator (which
    // re-reads toolRegistry.list() fresh every message) but silently
    // invisible the instant the same request got delegated to a
    // specialist, since dispatchDelegate/forced-role both just read
    // `agent.tools` directly. Found live via a real saved query that the
    // top-level orchestrator could see but the Data specialist could not.
    const registry = new ToolRegistry()
    registry.register(fakeTool('db_list_connections'))
    const agents = createAgents(registry)

    registry.register(fakeTool('db_query_orders_by_status_abc123'))

    const dataAgent = agents.get('data')
    expect(dataAgent?.tools.map((t) => t.name)).toContain('db_query_orders_by_status_abc123')
  })

  it('unregistering a tool is also reflected — a stale/deleted saved query does not linger', () => {
    const registry = new ToolRegistry()
    registry.register(fakeTool('db_query_temp_xyz789'))
    const agents = createAgents(registry)
    expect(agents.get('data')?.tools.map((t) => t.name)).toContain('db_query_temp_xyz789')

    registry.unregister('db_query_temp_xyz789')

    expect(agents.get('data')?.tools.map((t) => t.name)).not.toContain('db_query_temp_xyz789')
  })

  it('the fixed built-in tools are still present alongside dynamic ones', () => {
    const registry = new ToolRegistry()
    registry.register(fakeTool('db_list_connections'))
    registry.register(fakeTool('db_execute_sql'))
    const agents = createAgents(registry)

    const names = agents.get('data')?.tools.map((t) => t.name)
    expect(names).toContain('db_list_connections')
    expect(names).toContain('db_execute_sql')
  })

  it('a non-db_query_ tool registered later is not accidentally swept into the Data role', () => {
    const registry = new ToolRegistry()
    const agents = createAgents(registry)

    registry.register(fakeTool('read_file'))

    expect(agents.get('data')?.tools.map((t) => t.name)).not.toContain('read_file')
  })
})
