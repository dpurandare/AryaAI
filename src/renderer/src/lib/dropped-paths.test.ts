import { describe, expect, it } from 'vitest'
import { formatDroppedPath, formatDroppedPaths, insertDroppedPaths } from './dropped-paths'

describe('dropped file paths (#229)', () => {
  it('writes a path with spaces in double quotes, others bare', () => {
    expect(formatDroppedPath('/home/me/report.pdf')).toBe('/home/me/report.pdf')
    expect(formatDroppedPath('C:\\Users\\Me\\My Files\\Q3 report.pdf')).toBe('"C:\\Users\\Me\\My Files\\Q3 report.pdf"')
  })

  it('puts several paths on separate lines, and nothing for files without a path', () => {
    expect(formatDroppedPaths(['/a/b.txt', '/c d/e.csv'])).toBe('/a/b.txt\n"/c d/e.csv"')
    expect(formatDroppedPaths(['', ''])).toBe('')
    expect(formatDroppedPaths([])).toBe('')
  })

  it('appends to the draft without gluing onto a word', () => {
    expect(insertDroppedPaths('', ['/a.txt'])).toBe('/a.txt')
    expect(insertDroppedPaths('Summarise', ['/a.txt'])).toBe('Summarise /a.txt')
    expect(insertDroppedPaths('Summarise ', ['/a.txt'])).toBe('Summarise /a.txt')
    expect(insertDroppedPaths('Compare', ['/a.txt', '/b.txt'])).toBe('Compare\n/a.txt\n/b.txt')
    expect(insertDroppedPaths('line one\n', ['/a.txt'])).toBe('line one\n/a.txt')
  })

  it('leaves the draft alone when nothing had a path', () => {
    expect(insertDroppedPaths('hello', [''])).toBe('hello')
  })
})
