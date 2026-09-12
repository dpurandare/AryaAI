import { describe, expect, it } from 'vitest'
import { parseSearchHistoryResult } from './search-history-result'

describe('parseSearchHistoryResult', () => {
  it('parses a single tagged result, matching tool.ts\'s exact format', () => {
    const text =
      '<historical_result session="New Chat" date="2026-09-09" relevance="0.84">\n' +
      'The person must launch at **7.5 ft/s**.\n' +
      '</historical_result>'
    expect(parseSearchHistoryResult(text)).toEqual([
      { session: 'New Chat', date: '2026-09-09', relevance: '0.84', text: 'The person must launch at **7.5 ft/s**.' }
    ])
  })

  it('parses multiple results joined the way tool.ts joins them (newline-separated)', () => {
    const text = [
      '<historical_result session="A" date="2026-09-09" relevance="0.84">\nfirst\n</historical_result>',
      '<historical_result session="B" date="2026-09-08" relevance="0.61">\nsecond\n</historical_result>'
    ].join('\n')
    const results = parseSearchHistoryResult(text)
    expect(results).toHaveLength(2)
    expect(results?.[0]).toMatchObject({ session: 'A', text: 'first' })
    expect(results?.[1]).toMatchObject({ session: 'B', text: 'second' })
  })

  it('preserves multi-line/markdown body content, including a table', () => {
    const body = '| Step | Result |\n|------|--------|\n| 1 | 180 ft |'
    const text = `<historical_result session="X" date="2026-09-09" relevance="0.5">\n${body}\n</historical_result>`
    expect(parseSearchHistoryResult(text)?.[0].text).toBe(body)
  })

  it('handles a session title containing a literal double quote', () => {
    const text = '<historical_result session="What is "Windows Authenticode"?" date="2026-09-09" relevance="0.5">\nbody\n</historical_result>'
    const results = parseSearchHistoryResult(text)
    expect(results).not.toBeNull()
    expect(results?.[0].text).toBe('body')
  })

  it('returns null for a plain informational string (not indexed yet, unreachable, etc.)', () => {
    expect(parseSearchHistoryResult('(no relevant past conversations found for that query.)')).toBeNull()
    expect(parseSearchHistoryResult('(the history index is still building...)')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(parseSearchHistoryResult('')).toBeNull()
  })
})
