import { describe, expect, it } from 'vitest'
import { SYSTEM_PROMPT } from './system-prompt'

describe('SYSTEM_PROMPT (#156 — default tooling for diagrams/scripts/general code)', () => {
  it('defaults diagrams to Mermaid and data charts to matplotlib', () => {
    expect(SYSTEM_PROMPT).toContain('Mermaid.js')
    expect(SYSTEM_PROMPT).toContain('matplotlib')
  })

  it('defaults an ad-hoc program with no named language to Python', () => {
    expect(SYSTEM_PROMPT).toMatch(/default to Python/)
  })

  it('treats the literal word "script" as a separate trigger for the native shell, not Python', () => {
    expect(SYSTEM_PROMPT).toContain('"script"')
    expect(SYSTEM_PROMPT).toContain('native shell')
    expect(SYSTEM_PROMPT).toContain('overrides the general Python default')
  })

  it('states both defaults are overridden the moment a different language is named', () => {
    expect(SYSTEM_PROMPT).toMatch(/overridden the moment the user names a different language/)
  })
})
