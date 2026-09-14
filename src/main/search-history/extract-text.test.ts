import { describe, expect, it } from 'vitest'
import { extractSearchableText } from './extract-text'
import type { ContentBlock } from '@shared/protocol'

describe('extractSearchableText', () => {
  it('pulls text from text blocks', () => {
    const content: ContentBlock[] = [{ type: 'text', text: 'hello there' }]
    expect(extractSearchableText(content)).toBe('hello there')
  })

  it('pulls content from tool_result blocks', () => {
    const content: ContentBlock[] = [{ type: 'tool_result', toolUseId: 't1', content: 'result output' }]
    expect(extractSearchableText(content)).toBe('result output')
  })

  it('skips tool_use blocks entirely', () => {
    const content: ContentBlock[] = [{ type: 'tool_use', id: 't1', name: 'search_history', input: {} }]
    expect(extractSearchableText(content)).toBe('')
  })

  it('joins mixed blocks with a newline, skipping tool_use', () => {
    const content: ContentBlock[] = [
      { type: 'text', text: 'checking now' },
      { type: 'tool_use', id: 't1', name: 'web_search', input: { query: 'x' } },
      { type: 'tool_result', toolUseId: 't1', content: 'found something' },
      { type: 'text', text: 'here is the answer' }
    ]
    expect(extractSearchableText(content)).toBe('checking now\nfound something\nhere is the answer')
  })

  it('returns an empty string for an all-tool_use message', () => {
    const content: ContentBlock[] = [{ type: 'tool_use', id: 't1', name: 'x', input: {} }]
    expect(extractSearchableText(content)).toBe('')
  })

  describe('excludes search_history\'s own tool_result from being re-indexed', () => {
    // Found live: a search_history result relayed into a reply and then
    // indexed as if it were new content permanently bundled an unrelated
    // topic (a landing-speed calculation) into a later, totally unrelated
    // "second tallest mountain" search. Re-indexing search_history's own
    // output is never correct — it's always a copy of something already
    // indexed, or one of its own diagnostic messages, never new information.
    it('skips a real tagged result', () => {
      const content: ContentBlock[] = [
        {
          type: 'tool_result',
          toolUseId: 't1',
          content:
            '<historical_result session="Old session" date="2026-09-09" relevance="0.82">\n' +
            'The second-tallest mountain is K2.\n</historical_result>'
        }
      ]
      expect(extractSearchableText(content)).toBe('')
    })

    it('skips the "no results" diagnostic message', () => {
      const content: ContentBlock[] = [
        { type: 'tool_result', toolUseId: 't1', content: '(no relevant past conversations found for that query.)' }
      ]
      expect(extractSearchableText(content)).toBe('')
    })

    it('skips the "still building" and "needs rebuild" diagnostic messages', () => {
      const stillBuilding: ContentBlock[] = [
        { type: 'tool_result', toolUseId: 't1', content: '(the history index is still building...)' }
      ]
      const needsRebuild: ContentBlock[] = [
        { type: 'tool_result', toolUseId: 't1', content: '(the history index was built with a different model...)' }
      ]
      expect(extractSearchableText(stillBuilding)).toBe('')
      expect(extractSearchableText(needsRebuild)).toBe('')
    })

    it('skips the "not reachable" diagnostic message', () => {
      const content: ContentBlock[] = [
        { type: 'tool_result', toolUseId: 't1', content: "(history search isn't reachable right now...)" }
      ]
      expect(extractSearchableText(content)).toBe('')
    })

    it('still indexes a DIFFERENT tool\'s result unaffected, e.g. a real db query result', () => {
      const content: ContentBlock[] = [
        { type: 'tool_result', toolUseId: 't1', content: '1 row(s):\n[{"avg_salary": 91500}]' }
      ]
      expect(extractSearchableText(content)).toBe('1 row(s):\n[{"avg_salary": 91500}]')
    })

    it('drops only the search_history block, keeping real text/other tool_result content in a mixed message', () => {
      const content: ContentBlock[] = [
        { type: 'text', text: 'Yes, we discussed that.' },
        {
          type: 'tool_result',
          toolUseId: 't1',
          content: '<historical_result session="X" date="2026-09-09" relevance="0.8">stuff</historical_result>'
        }
      ]
      expect(extractSearchableText(content)).toBe('Yes, we discussed that.')
    })
  })
})
