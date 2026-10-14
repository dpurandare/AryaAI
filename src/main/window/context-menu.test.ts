import { describe, expect, it } from 'vitest'
import { buildContextMenuActions, type ContextMenuParams } from './context-menu'

const params = (over: Partial<ContextMenuParams> = {}): ContextMenuParams => ({
  misspelledWord: '',
  dictionarySuggestions: [],
  editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
  ...over
})

describe('buildContextMenuActions', () => {
  it('lists each suggestion, then Add to Dictionary, for a misspelled word', () => {
    const actions = buildContextMenuActions(params({ misspelledWord: 'teh', dictionarySuggestions: ['the', 'tea'] }))
    expect(actions).toEqual([
      { kind: 'replace', word: 'the' },
      { kind: 'replace', word: 'tea' },
      { kind: 'separator' },
      { kind: 'add-to-dictionary', word: 'teh' }
    ])
  })

  it('skips the suggestions separator when there are no suggestions, but still offers Add to Dictionary', () => {
    const actions = buildContextMenuActions(params({ misspelledWord: 'asdfgh', dictionarySuggestions: [] }))
    expect(actions).toEqual([{ kind: 'add-to-dictionary', word: 'asdfgh' }])
  })

  it('adds cut/copy/paste/select-all only for the edit flags Chromium actually reports', () => {
    const actions = buildContextMenuActions(params({ editFlags: { canCut: false, canCopy: true, canPaste: true, canSelectAll: true } }))
    expect(actions).toEqual([{ kind: 'copy' }, { kind: 'paste' }, { kind: 'select-all' }])
  })

  it('separates the spelling section from the edit section when both apply', () => {
    const actions = buildContextMenuActions(
      params({ misspelledWord: 'teh', dictionarySuggestions: ['the'], editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } })
    )
    expect(actions).toEqual([
      { kind: 'replace', word: 'the' },
      { kind: 'separator' },
      { kind: 'add-to-dictionary', word: 'teh' },
      { kind: 'separator' },
      { kind: 'cut' },
      { kind: 'copy' },
      { kind: 'paste' },
      { kind: 'select-all' }
    ])
  })

  it('returns nothing for a plain right-click with no selection on non-editable, non-misspelled content', () => {
    expect(buildContextMenuActions(params())).toEqual([])
  })
})
