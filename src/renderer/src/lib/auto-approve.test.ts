import { describe, expect, it } from 'vitest'
import { shouldAutoApprove, staleRuleNames } from './auto-approve'

describe('shouldAutoApprove (TASKS #218)', () => {
  it('a ticked rule approves that tool only; the session blanket approves any tool', () => {
    expect(shouldAutoApprove('write_file', false, { write_file: true })).toBe(true)
    expect(shouldAutoApprove('shell_execute', false, { write_file: true })).toBe(false)
    expect(shouldAutoApprove('shell_execute', true, {})).toBe(true)
    expect(shouldAutoApprove('write_file', false, { write_file: false })).toBe(false)
  })

  it('folder access outside the workspace is never auto-approved, by the blanket or by a rule', () => {
    expect(shouldAutoApprove('external_folder_access', true, {})).toBe(false)
    expect(shouldAutoApprove('external_folder_access', true, { external_folder_access: true })).toBe(false)
    expect(shouldAutoApprove('external_folder_access', false, { external_folder_access: true })).toBe(false)
  })
})

describe('staleRuleNames (TASKS #218)', () => {
  it('lists ticked rules for tools the app does not have now, sorted, and ignores unticked ones', () => {
    const tools = [{ name: 'write_file' }, { name: 'mcp__wiki__create_page' }]
    const rules = { write_file: true, mcp__old__gone: true, mcp_llmwiki: true, 'mcp__wiki__create_page': true, unticked_gone: false }
    expect(staleRuleNames(rules, tools)).toEqual(['mcp__old__gone', 'mcp_llmwiki'])
  })
  it('is empty when every rule names a current tool', () => {
    expect(staleRuleNames({ write_file: true }, [{ name: 'write_file' }])).toEqual([])
  })
})
