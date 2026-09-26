import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../tools/registry'
import type { Tool } from '../tools/types'
import { ROLE_MANIFEST } from '@shared/agents'
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

  it('every general-purpose specialist is told to flag a part of its task it cannot finish, except planning (no tools) and page-creator (fixed one-slide brief)', () => {
    // Found live: handed "search for X and write it into a Word document"
    // as one delegated step, Research searched, produced a text summary,
    // and stopped — it has no file-writing tools, so the document part
    // silently never happened. This note is the defensive backstop for
    // whenever a step still ends up needing something outside its role's
    // tools (classification miss, planning disabled, or a direct request).
    const agents = createAgents(new ToolRegistry())
    const note = "don't silently stop as if the whole request is done"

    for (const role of ['research', 'history-analyst', 'coding', 'data', 'data-processor', 'document-creator', 'configurator', 'email'] as const) {
      expect(agents.get(role)?.systemPrompt).toContain(note)
    }
    expect(agents.get('planning')?.systemPrompt).not.toContain(note)
    expect(agents.get('page-creator')?.systemPrompt).not.toContain(note)
  })

  it('creates exactly the roles in the manifest, and none of the retired ones', () => {
    const agents = createAgents(new ToolRegistry())
    expect([...agents.keys()]).toEqual(ROLE_MANIFEST.map((r) => r.id))
    expect(agents.has('terminal-devops' as never)).toBe(false)
    expect(agents.has('distribution' as never)).toBe(false)
  })

  describe('Developer (`coding`) writes AND runs — the fix for Appendix D1/D2', () => {
    // Found live twice (Northwind chart sessions): the old Coding role had no shell, said "I cannot
    // execute code", pasted scripts into chat, and the plan had no separate run step. Merging
    // Terminal/DevOps and Distribution into one role makes "write it, never run it" impossible to
    // express, not merely discouraged.
    const registry = new ToolRegistry()
    for (const n of ['read_file', 'write_file', 'shell_execute', 'git_exec', 'github_cli', 'aws_cli', 'show_media', 'db_execute_sql', 'office_create_document']) {
      registry.register(fakeTool(n))
    }
    const agents = createAgents(registry)
    const dev = agents.get('coding')!
    const names = dev.tools.map((t) => t.name)

    it('has a shell, git, cloud CLIs and GitHub — and no database or Office tools', () => {
      expect(names).toEqual(expect.arrayContaining(['shell_execute', 'write_file', 'git_exec', 'github_cli', 'aws_cli', 'show_media']))
      expect(names).not.toContain('db_execute_sql')
      expect(names).not.toContain('office_create_document')
    })

    it('is told it can run what it writes, and never to claim done without checking the output exists', () => {
      expect(dev.systemPrompt).toMatch(/you have a shell/i)
      expect(dev.systemPrompt).toMatch(/confirm the output actually exists/i)
      expect(dev.systemPrompt).not.toMatch(/NO shell/i)
      expect(dev.systemPrompt).not.toMatch(/delegate_to_terminal_devops/i)
    })

    it('is told not to send Python through `python -c` or paste multi-line code as a shell command (the D2 loop)', () => {
      expect(dev.systemPrompt).toMatch(/Never send Python source through `python -c/)
      expect(dev.systemPrompt).toMatch(/write the script to a \.py file/i)
    })

    it('is told never to invent sample data, and how to put charts into Word (python-docx) since office_create_document cannot', () => {
      expect(dev.systemPrompt).toMatch(/never invent sample or placeholder data/i)
      expect(dev.systemPrompt).toMatch(/python-docx/)
      expect(dev.systemPrompt).toMatch(/office_create_document cannot embed images/)
    })

    it('points at Settings > Runtime when Python is unavailable, instead of trying to install it', () => {
      expect(dev.systemPrompt).toMatch(/Settings > Runtime/)
    })
  })

  describe('the narrow roles own exactly their own tools', () => {
    const registry = new ToolRegistry()
    const all = [
      'web_search', 'parse_html', 'search_history', 'read_file', 'list_directory', 'write_file', 'shell_execute',
      'db_list_connections', 'db_execute_sql', 'api_list_connections', 'api_call', 'api_create_connection',
      'db_create_connection', 'mcp_create_connection', 'parse_csv', 'parse_json', 'parse_xml', 'xlsx_read', 'xlsx_write',
      'office_create_document', 'office_read_document', 'office_fill_template', 'office_extract_template'
    ]
    for (const n of all) registry.register(fakeTool(n))
    const agents = createAgents(registry)
    const toolsOf = (role: Parameters<typeof agents.get>[0]): string[] => agents.get(role)?.tools.map((t) => t.name) ?? []

    it('Researcher: web only — no history, no APIs, no files', () => {
      expect(toolsOf('research').sort()).toEqual(['parse_html', 'web_search'])
    })
    it('History Analyst: search_history only', () => {
      expect(toolsOf('history-analyst')).toEqual(['search_history'])
    })
    it('Data Access: databases and external APIs — no local-file parsing, no connection creation', () => {
      const t = toolsOf('data')
      expect(t).toEqual(expect.arrayContaining(['db_list_connections', 'db_execute_sql', 'api_list_connections', 'api_call']))
      expect(t).not.toContain('parse_csv')
      expect(t).not.toContain('db_create_connection')
      expect(t).not.toContain('api_create_connection')
    })
    it('Data Processor: structured local files, spreadsheets and read-only file access', () => {
      expect(toolsOf('data-processor').sort()).toEqual(['list_directory', 'parse_csv', 'parse_json', 'parse_xml', 'read_file', 'xlsx_read', 'xlsx_write'])
    })
    it('Document Creator: Office documents — no shell, no writes outside its own tools', () => {
      const t = toolsOf('document-creator')
      expect(t).toEqual(expect.arrayContaining(['office_create_document', 'office_read_document', 'office_fill_template', 'office_extract_template']))
      expect(t).not.toContain('shell_execute')
      expect(t).not.toContain('write_file')
    })
    it('Configurator: the three connection-creating tools, including mcp_create_connection which no role owned before', () => {
      expect(toolsOf('configurator').sort()).toEqual(['api_create_connection', 'db_create_connection', 'mcp_create_connection'])
    })
  })

  describe('MCP tool visibility per role (TASKS.md #99)', () => {
    // README.md documents MCP tools as available to the general-purpose roles — before
    // #99, no specialist's fixed tool list actually included them, so a
    // connected MCP tool was reachable from the top-level orchestrator
    // (the full registry) but silently disappeared the instant a request
    // was delegated to a specialist. Scoping MCP to a dedicated role is design step 5.
    it('a connected MCP tool is visible to Researcher, Developer and Data Access (the roles that had it before the split)', () => {
      const registry = new ToolRegistry()
      registry.register(fakeTool('mcp__gbrain__search_documents'))
      const agents = createAgents(registry)

      for (const role of ['research', 'coding', 'data'] as const) {
        expect(agents.get(role)?.tools.map((t) => t.name)).toContain('mcp__gbrain__search_documents')
      }
    })

    it('is live, same as saved queries — an MCP tool connected after createAgents() is still picked up', () => {
      const registry = new ToolRegistry()
      const agents = createAgents(registry)

      registry.register(fakeTool('mcp__wiki__get_page'))

      expect(agents.get('research')?.tools.map((t) => t.name)).toContain('mcp__wiki__get_page')
    })

    it('is NOT given to the narrow roles: planning, history, data-processor, document-creator, configurator, page-creator, email', () => {
      const registry = new ToolRegistry()
      registry.register(fakeTool('mcp__gbrain__search_documents'))
      const agents = createAgents(registry)

      for (const role of ['planning', 'history-analyst', 'data-processor', 'document-creator', 'configurator', 'page-creator', 'email'] as const) {
        expect(agents.get(role)?.tools.map((t) => t.name)).not.toContain('mcp__gbrain__search_documents')
      }
    })

    it('a non-mcp__ tool is not accidentally swept in by the same mechanism', () => {
      const registry = new ToolRegistry()
      registry.register(fakeTool('web_search'))
      const agents = createAgents(registry)

      // web_search is already a named tool for research — this just confirms
      // it wasn't *also* duplicated in by mcpTools' prefix filter.
      const names = agents.get('research')?.tools.map((t) => t.name) ?? []
      expect(names.filter((n) => n === 'web_search')).toHaveLength(1)
    })
  })

  it('gives show_media (TASKS.md #82) to the Developer — the role that generates images — not to every role', () => {
    const registry = new ToolRegistry()
    registry.register(fakeTool('show_media'))
    const agents = createAgents(registry)

    expect(agents.get('coding')?.tools.map((t) => t.name)).toContain('show_media')
    expect(agents.get('research')?.tools.map((t) => t.name)).not.toContain('show_media')
    expect(agents.get('data')?.tools.map((t) => t.name)).not.toContain('show_media')
  })
})
