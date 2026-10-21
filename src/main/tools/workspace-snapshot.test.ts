import { describe, expect, it } from 'vitest'
import { showMediaHint } from './workspace-snapshot'

describe('showMediaHint (TASKS #236)', () => {
  it('names the image files a run produced and tells the model to call show_media', () => {
    expect(showMediaHint(['resources/bars.png', 'data.csv'])).toBe(
      'Image file(s) created or changed: resources/bars.png. Call show_media with each path so the user sees it in the chat.'
    )
    expect(showMediaHint(['a.PNG', 'b.svg'])).toContain('a.PNG, b.svg')
    expect(showMediaHint(['a.jpg', 'b.webp'])).toContain('sees them')
  })
  it('is null when no image was produced, and ignores scratch and internal folders', () => {
    expect(showMediaHint(['report.docx', 'data.csv'])).toBeNull()
    expect(showMediaHint(['tmp/plot.png', '.sachiv-handoff/x.png'])).toBeNull()
    expect(showMediaHint([])).toBeNull()
  })
  it('lists at most a few paths', () => {
    const hint = showMediaHint(Array.from({ length: 9 }, (_, i) => `resources/p${i}.png`))!
    expect(hint).toContain('(and 4 more)')
    expect(hint).not.toContain('p8.png')
  })
})
