import { describe, expect, it } from 'vitest'
import { stripHandoffTag } from './handoff-tag'

describe('stripHandoffTag', () => {
  it('removes a trailing handoff tag and leaves the sentence', () => {
    expect(stripHandoffTag("That is not my job.\n[handoff: out_of_scope -> coding]")).toBe('That is not my job.')
    expect(stripHandoffTag('Which file? [handoff: needs_input]')).toBe('Which file?')
  })

  it('leaves text without a tag, or with the tag quoted mid-text, alone', () => {
    expect(stripHandoffTag('Hello')).toBe('Hello')
    expect(stripHandoffTag('Use [handoff: out_of_scope] when it is not yours, then carry on.')).toContain('[handoff: out_of_scope]')
  })
})
