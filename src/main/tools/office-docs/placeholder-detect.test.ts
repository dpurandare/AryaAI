import { describe, expect, it } from 'vitest'
import { detectPlaceholderCandidates } from './placeholder-detect'

describe('detectPlaceholderCandidates', () => {
  it('detects a date, currency amount, email, and percentage', () => {
    const candidates = detectPlaceholderCandidates([
      'Invoice Date: 2026-09-24',
      'Amount Due: $1,250.00',
      'Contact: sales@acme.example.com',
      'Discount: 15%'
    ])
    expect(candidates).toContainEqual({ text: '2026-09-24', category: 'date', suggestedName: 'date1', occurrences: 1 })
    expect(candidates).toContainEqual({ text: '$1,250.00', category: 'currency', suggestedName: 'currency1', occurrences: 1 })
    expect(candidates).toContainEqual({
      text: 'sales@acme.example.com',
      category: 'email',
      suggestedName: 'email1',
      occurrences: 1
    })
    expect(candidates).toContainEqual({ text: '15%', category: 'percentage', suggestedName: 'percentage1', occurrences: 1 })
  })

  it('detects month-name dates in both orders', () => {
    const candidates = detectPlaceholderCandidates(['Due September 24, 2026', 'Signed 24 September 2026'])
    expect(candidates.map((c) => c.text)).toEqual(
      expect.arrayContaining(['September 24, 2026', '24 September 2026'])
    )
  })

  it('detects a phone number and a URL', () => {
    const candidates = detectPlaceholderCandidates(['Call 555-123-4567', 'See https://acme.example.com/invoice'])
    expect(candidates.some((c) => c.category === 'phone' && c.text === '555-123-4567')).toBe(true)
    expect(candidates.some((c) => c.category === 'url' && c.text === 'https://acme.example.com/invoice')).toBe(true)
  })

  it('counts repeated occurrences of the exact same text across runs, without duplicating the candidate', () => {
    const candidates = detectPlaceholderCandidates(['Total: $1,250.00', 'Confirmed total: $1,250.00'])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toEqual({ text: '$1,250.00', category: 'currency', suggestedName: 'currency1', occurrences: 2 })
  })

  it('numbers suggested names sequentially within a category, across multiple distinct values', () => {
    const candidates = detectPlaceholderCandidates(['a@x.com', 'b@y.com'])
    expect(candidates.map((c) => c.suggestedName)).toEqual(['email1', 'email2'])
  })

  it('does not flag plain prose with no variable-looking content at all', () => {
    expect(detectPlaceholderCandidates(['Thank you for your business.', 'Please review the attached terms.'])).toEqual([])
  })

  it('does not attempt to detect names or free-text labels — a known, documented limitation', () => {
    const candidates = detectPlaceholderCandidates(['Prepared by John Smith', 'Acme Corporation'])
    expect(candidates).toEqual([])
  })
})
