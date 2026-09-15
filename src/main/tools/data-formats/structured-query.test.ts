import { describe, expect, it } from 'vitest'
import { appendAtPath, queryPath, summarizeValue } from './structured-query'

describe('summarizeValue', () => {
  it('describes a flat object', () => {
    expect(summarizeValue({ a: 1, b: 'x' })).toBe('{ a: number, b: string "x" }')
  })

  it('describes an array of objects by its first element', () => {
    expect(summarizeValue([{ id: 1 }, { id: 2 }])).toBe('Array(2) of { id: number }')
  })

  it('describes an empty array without recursing', () => {
    expect(summarizeValue([])).toBe('Array(0)')
  })

  it('caps recursion depth on deeply nested objects', () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } }
    expect(summarizeValue(deep)).not.toContain('e: number')
  })

  it('caps the number of keys shown', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]))
    const shape = summarizeValue(many)
    expect(shape).toContain('…')
  })

  it('previews a long string, truncated', () => {
    const shape = summarizeValue({ text: 'x'.repeat(200) })
    expect(shape).toContain('…')
    expect(shape.length).toBeLessThan(150)
  })

  it('handles null and primitives', () => {
    expect(summarizeValue(null)).toBe('null')
    expect(summarizeValue(42)).toBe('number')
    expect(summarizeValue(true)).toBe('boolean')
  })
})

describe('queryPath', () => {
  const data = { items: [{ name: 'a', tags: ['x', 'y'] }, { name: 'b', tags: [] }], count: 2 }

  it('returns the whole value for an empty path', () => {
    expect(queryPath(data, '')).toEqual([data])
    expect(queryPath(data, '$')).toEqual([data])
  })

  it('resolves a simple key path', () => {
    expect(queryPath(data, 'count')).toEqual([2])
  })

  it('resolves a numeric index', () => {
    expect(queryPath(data, 'items[0].name')).toEqual(['a'])
  })

  it('expands a wildcard into every match', () => {
    expect(queryPath(data, 'items[*].name')).toEqual(['a', 'b'])
  })

  it('expands a wildcard over object values too', () => {
    expect(queryPath({ a: 1, b: 2 }, '[*]')).toEqual([1, 2])
  })

  it('returns nothing for a missing key, not an error', () => {
    expect(queryPath(data, 'nope')).toEqual([])
  })

  it('returns nothing for an out-of-range index', () => {
    expect(queryPath(data, 'items[9]')).toEqual([])
  })
})

describe('appendAtPath', () => {
  it('appends to the root when it is an array and path is empty', () => {
    const root: unknown[] = [1, 2]
    appendAtPath(root, '', 3)
    expect(root).toEqual([1, 2, 3])
  })

  it('throws when the root is not an array and path is empty', () => {
    expect(() => appendAtPath({ a: 1 }, '', 2)).toThrow(/Root is not an array/)
  })

  it('appends to an array field found at a key path', () => {
    const root = { items: [{ id: 1 }] }
    appendAtPath(root, 'items', { id: 2 })
    expect(root.items).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('creates the array field if it does not exist yet', () => {
    const root: { items?: unknown[] } = {}
    appendAtPath(root, 'items', 'x')
    expect(root.items).toEqual(['x'])
  })

  it('appends into a nested array element', () => {
    const root = { groups: [{ items: [1] }, { items: [2] }] }
    appendAtPath(root, 'groups[1].items', 3)
    expect(root.groups[1].items).toEqual([2, 3])
  })

  it('throws on a wildcard path', () => {
    expect(() => appendAtPath({ items: [] }, 'items[*]', 1)).toThrow(/wildcard/)
  })

  it('throws when the target field is not an array', () => {
    expect(() => appendAtPath({ items: 'not an array' }, 'items', 1)).toThrow(/is not an array/)
  })
})
