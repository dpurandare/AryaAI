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
})
