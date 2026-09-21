import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import { officeReadDocumentTool } from '../office-docs/read'
import type { ToolContext } from '../types'
import { pptxAddSlideTool, pptxComposeSlideTool, pptxSaveDeckTool, pptxStartDeckTool } from './index'

describe('deck tools (#78)', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-deck-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session', activeDecks: new Map() }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('none of the lifecycle tools mutate except save', () => {
    expect(pptxStartDeckTool.mutates).toBe(false)
    expect(pptxAddSlideTool.mutates).toBe(false)
    expect(pptxComposeSlideTool.mutates).toBe(false)
    expect(pptxSaveDeckTool.mutates).toBe(true)
  })

  it('full real lifecycle: start, add 2 slides, compose each with every element type, save, read back', async () => {
    const startResult = await pptxStartDeckTool.execute({}, ctx)
    const deckId = /"([^"]+)"/.exec(startResult)?.[1]
    expect(deckId).toBeTruthy()

    await pptxAddSlideTool.execute({ deckId }, ctx)
    await pptxAddSlideTool.execute({ deckId }, ctx)

    await pptxComposeSlideTool.execute(
      {
        deckId,
        slideIndex: 0,
        elements: [
          { type: 'text', text: 'Q3 Overview', x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 28, bold: true },
          { type: 'shape', shape: 'rect', x: 0.5, y: 1.5, w: 2, h: 1, fill: 'FF0000' }
        ]
      },
      ctx
    )

    await pptxComposeSlideTool.execute(
      {
        deckId,
        slideIndex: 1,
        elements: [
          {
            type: 'chart',
            chartType: 'bar',
            categories: ['Jan', 'Feb'],
            series: [{ name: 'Revenue', values: [10, 20] }],
            x: 0.5,
            y: 0.5,
            w: 5,
            h: 3
          },
          { type: 'table', rows: [['Name', 'Total'], ['Ada', '150']], x: 0.5, y: 4, w: 4, h: 2 }
        ]
      },
      ctx
    )

    const saveResult = await pptxSaveDeckTool.execute({ deckId, path: 'deck.pptx' }, ctx)
    expect(saveResult).toBe('Saved deck.pptx (2 slide(s)).')

    // The deck is discarded from memory after saving.
    await expect(pptxComposeSlideTool.execute({ deckId, slideIndex: 0, elements: [] }, ctx)).rejects.toThrow(/Unknown deck/)

    // Real file, real readable content.
    const text = await officeReadDocumentTool.execute({ path: 'deck.pptx' }, ctx)
    expect(text).toContain('Slide 1:')
    expect(text).toContain('Q3 Overview')
    expect(text).toContain('Slide 2:')
  })

  it('rejects composing an unknown deck', async () => {
    await expect(
      pptxComposeSlideTool.execute({ deckId: 'nope', slideIndex: 0, elements: [{ type: 'text', text: 'x', x: 0, y: 0, w: 1, h: 1 }] }, ctx)
    ).rejects.toThrow(/Unknown deck "nope"/)
  })

  it('rejects composing a slide index that was never added', async () => {
    const startResult = await pptxStartDeckTool.execute({}, ctx)
    const deckId = /"([^"]+)"/.exec(startResult)?.[1]
    await expect(
      pptxComposeSlideTool.execute({ deckId, slideIndex: 0, elements: [{ type: 'text', text: 'x', x: 0, y: 0, w: 1, h: 1 }] }, ctx)
    ).rejects.toThrow(/has no slide at index 0/)
  })

  it('omitting deckId/slideIndex defaults to the sole active deck and its most recently added slide', async () => {
    // Real live-testing finding (#78): an opaque deckId is easy for a local
    // model to mangle/invent when it has to survive a round-trip through
    // the free-text task handed to the isolated page-creator delegate —
    // this is the fix, and the case it actually needs to cover.
    await pptxStartDeckTool.execute({}, ctx)
    await pptxAddSlideTool.execute({}, ctx)
    await pptxAddSlideTool.execute({}, ctx)

    const result = await pptxComposeSlideTool.execute(
      { elements: [{ type: 'text', text: 'Auto-targeted', x: 0.5, y: 0.5, w: 5, h: 1 }] },
      ctx
    )
    expect(result).toContain('Composed slide 1') // the most recently added slide, index 1

    const saveResult = await pptxSaveDeckTool.execute({ path: 'auto.pptx' }, ctx)
    expect(saveResult).toBe('Saved auto.pptx (2 slide(s)).')
    const text = await officeReadDocumentTool.execute({ path: 'auto.pptx' }, ctx)
    expect(text).toContain('Auto-targeted')
  })

  it('requires an explicit deckId when more than one deck is genuinely in progress', async () => {
    const first = /"([^"]+)"/.exec(await pptxStartDeckTool.execute({}, ctx))?.[1]
    await pptxStartDeckTool.execute({}, ctx)

    await expect(
      pptxComposeSlideTool.execute({ elements: [{ type: 'text', text: 'x', x: 0, y: 0, w: 1, h: 1 }] }, ctx)
    ).rejects.toThrow(/Multiple decks are in progress/)

    // Still works fine once disambiguated explicitly.
    await pptxAddSlideTool.execute({ deckId: first }, ctx)
    await expect(
      pptxComposeSlideTool.execute({ deckId: first, elements: [{ type: 'text', text: 'x', x: 0, y: 0, w: 1, h: 1 }] }, ctx)
    ).resolves.toContain('Composed slide 0')
  })

  it('rejects an empty elements array with a clear message', async () => {
    const startResult = await pptxStartDeckTool.execute({}, ctx)
    const deckId = /"([^"]+)"/.exec(startResult)?.[1]
    await pptxAddSlideTool.execute({ deckId }, ctx)
    await expect(pptxComposeSlideTool.execute({ deckId, slideIndex: 0, elements: [] }, ctx)).rejects.toThrow(
      '"elements" must be a non-empty array.'
    )
  })

  it('respects the workspace boundary for an image element path', async () => {
    const startResult = await pptxStartDeckTool.execute({}, ctx)
    const deckId = /"([^"]+)"/.exec(startResult)?.[1]
    await pptxAddSlideTool.execute({ deckId }, ctx)
    await expect(
      pptxComposeSlideTool.execute(
        { deckId, slideIndex: 0, elements: [{ type: 'image', path: '../escape.png', x: 0, y: 0, w: 1, h: 1 }] },
        ctx
      )
    ).rejects.toThrow(/workspace boundary/)
  })

  it('respects the workspace boundary for the saved output path', async () => {
    const startResult = await pptxStartDeckTool.execute({}, ctx)
    const deckId = /"([^"]+)"/.exec(startResult)?.[1]
    await pptxAddSlideTool.execute({ deckId }, ctx)
    await pptxComposeSlideTool.execute(
      { deckId, slideIndex: 0, elements: [{ type: 'text', text: 'x', x: 0, y: 0, w: 1, h: 1 }] },
      ctx
    )
    await expect(pptxSaveDeckTool.execute({ deckId, path: '../escape.pptx' }, ctx)).rejects.toThrow(/workspace boundary/)
  })

  it('throws a clear error when the tool context has no activeDecks (e.g. a bare test context)', async () => {
    await expect(pptxStartDeckTool.execute({}, { workspaceGuard: ctx.workspaceGuard, currentSessionId: 't' })).rejects.toThrow(
      'Deck tools are unavailable in this context.'
    )
  })
})
