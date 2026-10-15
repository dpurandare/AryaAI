import { describe, expect, it } from 'vitest'
// @ts-expect-error - a plain ES module script, no type declarations
import { buildMarkdown, headingsOf, imageRefs, rewriteImageTargets, slug } from './export-docs.mjs'

describe('export-docs', () => {
  it('finds local image references with their alt text and ignores remote ones and fenced code', () => {
    const md = ['![Settings](images/settings.png)', '![web](https://example.com/a.png)', '![data](data:image/png;base64,AAA)', '```', '![in code](images/no.png)', '```', '![spaced](<images/a b.png> "Title")'].join('\n')
    expect(imageRefs(md)).toEqual([
      { alt: 'Settings', target: 'images/settings.png' },
      { alt: 'spaced', target: 'images/a b.png' }
    ])
  })

  it('rewrites only local targets, keeps the title, encodes spaces and leaves code alone', () => {
    const md = ['![a](images/one.png)', '![w](https://example.com/x.png)', '```', '![c](images/one.png)', '```', '![t](images/two.png "Cap")'].join('\n')
    const out = rewriteImageTargets(md, (t: string) => `out dir/${t.replace('images/', '')}`)
    expect(out.split('\n')).toEqual(['![a](out%20dir/one.png)', '![w](https://example.com/x.png)', '```', '![c](images/one.png)', '```', '![t](out%20dir/two.png "Cap")'])
  })

  it('builds a table of contents from level 1-2 headings outside code and numbers duplicate anchors', () => {
    const pages = [
      { file: '01.md', text: '# One\n\n## Setup\n\n```\n# not a heading\n```' },
      { file: '02.md', text: '# Two\n\n## Setup' }
    ]
    expect(headingsOf(pages[0].text).map((h: { text: string }) => h.text)).toEqual(['One', 'Setup'])
    const md = buildMarkdown(pages, 'Guide', '1.0.0', '2026-01-01')
    expect(md).toContain('- [One](#one)\n  - [Setup](#setup)\n- [Two](#two)\n  - [Setup](#setup-1)')
    expect(slug('What it is "not"?')).toBe('what-it-is-not')
  })
})
