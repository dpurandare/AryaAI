import { describe, expect, it } from 'vitest'
import { sourceRank, toolSourceLabel } from './tool-source'

describe('toolSourceLabel (TASKS #218)', () => {
  it('names the MCP server, a saved query, or built-in', () => {
    expect(toolSourceLabel({ name: 'mcp__llmwiki__create_page', mcp: { server: 'llmwiki' } })).toBe('MCP server: llmwiki')
    expect(toolSourceLabel({ name: 'db_query_top_customers_ab12' })).toBe('Saved query')
    expect(toolSourceLabel({ name: 'write_file' })).toBe('Built-in')
    expect(toolSourceLabel({ name: 'mcp_create_connection' })).toBe('Built-in')
  })
  it('orders built-in, then saved queries, then MCP servers', () => {
    expect(['MCP server: a', 'Saved query', 'Built-in'].sort((a, b) => sourceRank(a) - sourceRank(b))).toEqual(['Built-in', 'Saved query', 'MCP server: a'])
  })
})
