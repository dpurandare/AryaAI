import { describe, expect, it } from 'vitest'
import { chunkText } from './chunk-text'

describe('chunkText', () => {
  it('returns a single chunk for text with no blank lines', () => {
    expect(chunkText('revenue was 4.2 million')).toEqual(['revenue was 4.2 million'])
  })

  it('splits on a blank line into separate chunks, matching a real composite-answer shape', () => {
    const text =
      '**Tallest mountain discussed:**\nMount Everest is the tallest mountain in the world.\n\n' +
      '**Horizontal speed needed for a 50-ft landing:**\nYou need roughly 15 ft/s to land 50 feet away.'
    expect(chunkText(text)).toEqual([
      '**Tallest mountain discussed:**\nMount Everest is the tallest mountain in the world.',
      '**Horizontal speed needed for a 50-ft landing:**\nYou need roughly 15 ft/s to land 50 feet away.'
    ])
  })

  it('never drops a short-but-real message just because it falls under the noise floor', () => {
    expect(chunkText('OK.')).toEqual(['OK.'])
  })

  it('filters out stray short fragments between real paragraphs', () => {
    const text = 'A real paragraph with actual content in it.\n\n---\n\nAnother real paragraph with content.'
    const chunks = chunkText(text)
    expect(chunks).toEqual(['A real paragraph with actual content in it.', 'Another real paragraph with content.'])
  })

  it('returns an empty array for empty/whitespace-only input', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\n  ')).toEqual([])
  })

  it('trims each chunk', () => {
    expect(chunkText('  first paragraph with content  \n\n  second paragraph with content  ')).toEqual([
      'first paragraph with content',
      'second paragraph with content'
    ])
  })

  it('splits a single unbroken paragraph over 4000 chars into multiple hard-bounded chunks (TASKS #171)', () => {
    // A real raw tool_result JSON blob has no blank lines anywhere in it, so it survives
    // paragraph-splitting as one chunk — found live, a 30KB+ one of these crashed the local embedding
    // server by exceeding its real context window. No chunk should ever reach embed() this large.
    const oneLongParagraph = 'x'.repeat(9500)
    const chunks = chunkText(oneLongParagraph)
    expect(chunks).toHaveLength(3) // 4000 + 4000 + 1500
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000)
    expect(chunks.join('')).toBe(oneLongParagraph) // no content lost, just split
  })

  it('still splits on blank lines first, then caps any individual paragraph that is itself oversized', () => {
    const text = 'short first paragraph with real content' + '\n\n' + 'y'.repeat(4500)
    const chunks = chunkText(text)
    expect(chunks[0]).toBe('short first paragraph with real content')
    expect(chunks.length).toBe(3) // the first paragraph, unchanged, plus the oversized second split in two
    expect(chunks[1].length).toBeLessThanOrEqual(4000)
    expect(chunks[2].length).toBeLessThanOrEqual(4000)
  })
})
