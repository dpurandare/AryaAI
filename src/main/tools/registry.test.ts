import { describe, expect, it } from 'vitest'
import { ToolRegistry } from './registry'
import type { Tool } from './types'

function makeTool(name: string, mutates = false): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    mutates,
    async execute() {
      return `${name} result`
    }
  }
}

describe('ToolRegistry', () => {
  it('returns undefined for an unregistered tool', () => {
    expect(new ToolRegistry().get('nope')).toBeUndefined()
  })

  it('registers and retrieves a tool by name', () => {
    const registry = new ToolRegistry()
    const tool = makeTool('read_file')
    registry.register(tool)
    expect(registry.get('read_file')).toBe(tool)
  })

  it('lists every registered tool', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('a'))
    registry.register(makeTool('b'))
    expect(registry.list().map((t) => t.name).sort()).toEqual(['a', 'b'])
  })

  it('a later registration under the same name replaces the earlier one', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('a'))
    const replacement = makeTool('a', true)
    registry.register(replacement)
    expect(registry.get('a')).toBe(replacement)
    expect(registry.list()).toHaveLength(1)
  })

  it('projects registered tools to ToolDefinitions (name/description/inputSchema only)', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('a', true))
    expect(registry.toDefinitions()).toEqual([
      { name: 'a', description: 'a description', inputSchema: { type: 'object', properties: {} } }
    ])
  })
})
