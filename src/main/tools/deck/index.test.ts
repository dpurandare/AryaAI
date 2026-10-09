import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import { officeReadDocumentTool } from '../office-docs/read'
import type { ToolContext } from '../types'
import { normalizeElement } from './elements'
import { pptxAddSlideTool, pptxComposeSlideTool, pptxSaveDeckTool, pptxStartDeckTool } from './index'

// Smallest possible valid PNG (1x1, transparent) — real bytes, for tests that
// need an image element to point at a file that genuinely exists.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

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
          { type: 'table', rows: [['Name', 'Total'], ['Ada', '150']], x: 0.5, y: 3.6, w: 4, h: 1.8 }
        ]
      },
      ctx
    )

    const saveResult = await pptxSaveDeckTool.execute({ deckId, path: 'deck.pptx' }, ctx)
    expect(saveResult).toBe('Saved documents/deck.pptx (2 slide(s)).')

    // The deck is discarded from memory after saving.
    await expect(pptxComposeSlideTool.execute({ deckId, slideIndex: 0, elements: [] }, ctx)).rejects.toThrow(/Unknown deck/)

    // Real file, real readable content.
    const text = await officeReadDocumentTool.execute({ path: 'documents/deck.pptx' }, ctx)
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
    expect(saveResult).toBe('Saved documents/auto.pptx (2 slide(s)).')
    const text = await officeReadDocumentTool.execute({ path: 'documents/auto.pptx' }, ctx)
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

  it('composes a real, existing image file onto the slide', async () => {
    await writeFile(join(root, 'logo.png'), TINY_PNG)
    const startResult = await pptxStartDeckTool.execute({}, ctx)
    const deckId = /"([^"]+)"/.exec(startResult)?.[1]
    await pptxAddSlideTool.execute({ deckId }, ctx)
    await expect(
      pptxComposeSlideTool.execute(
        { deckId, slideIndex: 0, elements: [{ type: 'image', path: 'logo.png', x: 0, y: 0, w: 1, h: 1 }] },
        ctx
      )
    ).resolves.toContain('Composed slide 0')
    // Real file, not just an in-memory addImage() call that never gets read.
    await expect(pptxSaveDeckTool.execute({ deckId, path: 'with-image.pptx' }, ctx)).resolves.toContain('Saved')
  })

  it(
    'rejects an image element whose path does not exist in the workspace, with a clear message ' +
      '(pptxgenjs itself only reads the file at save time, which would otherwise surface as a confusing ' +
      'ENOENT far from the actual mistake)',
    async () => {
      const startResult = await pptxStartDeckTool.execute({}, ctx)
      const deckId = /"([^"]+)"/.exec(startResult)?.[1]
      await pptxAddSlideTool.execute({ deckId }, ctx)
      await expect(
        pptxComposeSlideTool.execute(
          { deckId, slideIndex: 0, elements: [{ type: 'image', path: 'nonexistent-icon.png', x: 0, y: 0, w: 1, h: 1 }] },
          ctx
        )
      ).rejects.toThrow(/does not exist in the workspace/)
    }
  )

  it(
    'does not leave any elements applied when one element in the batch is invalid — a corrected retry ' +
      'must not duplicate the earlier, already-valid elements (live-found: a slide ended up with the same ' +
      'text and chart twice after a failed "map" element was fixed and the call was retried)',
    async () => {
      const startResult = await pptxStartDeckTool.execute({}, ctx)
      const deckId = /"([^"]+)"/.exec(startResult)?.[1]
      await pptxAddSlideTool.execute({ deckId }, ctx)

      await expect(
        pptxComposeSlideTool.execute(
          {
            deckId,
            slideIndex: 0,
            elements: [
              { type: 'text', text: 'Analytics Landscape', x: 0.5, y: 0.3, w: 9, h: 1 },
              { type: 'map', x: 0, y: 0, w: 1, h: 1 }
            ]
          },
          ctx
        )
      ).rejects.toThrow(/Unknown element type "map"/)

      // Retry with the corrected array (as the role prompt now instructs).
      await pptxComposeSlideTool.execute(
        {
          deckId,
          slideIndex: 0,
          elements: [{ type: 'text', text: 'Analytics Landscape', x: 0.5, y: 0.3, w: 9, h: 1 }]
        },
        ctx
      )

      await pptxSaveDeckTool.execute({ deckId, path: 'no-dup.pptx' }, ctx)
      const text = await officeReadDocumentTool.execute({ path: 'documents/no-dup.pptx' }, ctx)
      const occurrences = text.split('Analytics Landscape').length - 1
      expect(occurrences).toBe(1)
    }
  )

  it('throws a clear error when the tool context has no activeDecks (e.g. a bare test context)', async () => {
    await expect(pptxStartDeckTool.execute({}, { workspaceGuard: ctx.workspaceGuard, currentSessionId: 't' })).rejects.toThrow(
      'Deck tools are unavailable in this context.'
    )
  })

  describe('line breaks and what is reported back (found live: literal \\n in a slide, and invented content)', () => {
    it('turns a literal backslash-n (an escape escaped twice) into a real line break in text and table cells, so no "\\n" shows on the slide', async () => {
      const deckId = /"([^"]+)"/.exec(await pptxStartDeckTool.execute({}, ctx))?.[1]
      await pptxAddSlideTool.execute({ deckId }, ctx)
      await pptxComposeSlideTool.execute(
        {
          deckId,
          elements: [
            { type: 'text', text: '• First\\n• Second\\r\\n• Third', x: 0.5, y: 0.5, w: 4, h: 2 },
            { type: 'table', rows: [['a\\nb', 'c']], x: 5, y: 0.5, w: 4, h: 1 }
          ]
        },
        ctx
      )
      const saved = String(await pptxSaveDeckTool.execute({ deckId, path: 'breaks.pptx' }, ctx))
      const text = String(await officeReadDocumentTool.execute({ path: saved.match(/documents\/\S+\.pptx/)?.[0] ?? '' }, ctx))
      expect(text).toContain('First')
      expect(text).toContain('Second')
      expect(text).not.toContain('\\n')
      expect(text).not.toContain('\\r')
    })

    it('quotes the text now on the slide in the compose result, so what is reported matches what is there', async () => {
      const deckId = /"([^"]+)"/.exec(await pptxStartDeckTool.execute({}, ctx))?.[1]
      await pptxAddSlideTool.execute({ deckId }, ctx)
      const out = await pptxComposeSlideTool.execute(
        { deckId, elements: [{ type: 'text', text: 'Project Aurora roadmap', x: 1, y: 1, w: 8, h: 1 }, { type: 'shape', shape: 'rect', x: 1, y: 3, w: 8, h: 0.1 }, { type: 'text', text: 'Home-energy dashboard', x: 1, y: 2, w: 8, h: 0.6 }] },
        ctx
      )
      expect(out).toContain('Text on the slide: "Project Aurora roadmap" | "Home-energy dashboard".')
    })
  })

  describe('shape names (found live: "oval" is not a PowerPoint shape, and PowerPoint asked to repair the deck)', () => {
    async function savedSlide(shape: string): Promise<string> {
      const started = await pptxStartDeckTool.execute({ slides: 1 }, ctx)
      const deckId = /"([^"]+)"/.exec(started)?.[1]
      await pptxComposeSlideTool.execute({ deckId, elements: [{ type: 'shape', shape, x: 1, y: 1, w: 1, h: 1, fill: '156082' }] }, ctx)
      await pptxSaveDeckTool.execute({ deckId, path: 'documents/shape.pptx' }, ctx)
      const zip = await JSZip.loadAsync(await readFile(join(root, 'documents/shape.pptx')))
      return zip.file('ppt/slides/slide1.xml')!.async('string')
    }

    it('writes "ellipse" for oval and circle, and keeps real names as they are', async () => {
      expect(await savedSlide('oval')).toContain('prst="ellipse"')
      expect(await savedSlide('Circle')).toContain('prst="ellipse"')
      expect(await savedSlide('roundRect')).toContain('prst="roundRect"')
    })

    it('refuses a name that is no shape, and says what to use, rather than writing it into the file', async () => {
      const started = await pptxStartDeckTool.execute({ slides: 1 }, ctx)
      const deckId = /"([^"]+)"/.exec(started)?.[1]
      await expect(
        pptxComposeSlideTool.execute({ deckId, elements: [{ type: 'shape', shape: 'blob', x: 1, y: 1, w: 1, h: 1 }] }, ctx)
      ).rejects.toThrow(/"blob" is not a shape name.*ellipse/)
    })
  })

  describe('a deck started with all its slides at once (saves a round per slide)', () => {
    it('creates N empty slides in one call, and an unindexed compose fills the first still-empty slide in order', async () => {
      const started = await pptxStartDeckTool.execute({ slides: 3 }, ctx)
      expect(started).toMatch(/with 3 empty slides \(indexes 0 to 2\)/)
      const deckId = /"([^"]+)"/.exec(started)?.[1]
      const compose = (text: string, slideIndex?: number): Promise<string> =>
        pptxComposeSlideTool.execute({ deckId, ...(slideIndex === undefined ? {} : { slideIndex }), elements: [{ type: 'text', text, x: 1, y: 1, w: 4, h: 1 }] }, ctx)
      expect(await compose('first')).toContain('Composed slide 0')
      expect(await compose('second')).toContain('Composed slide 1')
      expect(await compose('explicit third', 2)).toContain('Composed slide 2')
      expect(await compose('fourth, nothing empty left')).toContain('Composed slide 2') // falls back to the last slide
    })

    it('clamps the count, and a plain start still creates no slides', async () => {
      expect(await pptxStartDeckTool.execute({ slides: 500 }, ctx)).toMatch(/with 40 empty slides/)
      expect(await pptxStartDeckTool.execute({}, ctx)).toMatch(/^Started deck "[^"]+"\.$/)
    })
  })

  describe('pictures and overlays (design tools for the Page Creator)', () => {
    async function savedSlideXml(elements: Array<Record<string, unknown>>): Promise<string> {
      const deckId = /"([^"]+)"/.exec(await pptxStartDeckTool.execute({}, ctx))?.[1]
      await pptxAddSlideTool.execute({ deckId }, ctx)
      await pptxComposeSlideTool.execute({ deckId, elements }, ctx)
      const saved = String(await pptxSaveDeckTool.execute({ deckId, path: 'pic.pptx' }, ctx))
      const { default: JSZip } = await import('jszip')
      const zip = await JSZip.loadAsync(await (await import('node:fs/promises')).readFile(join(root, saved.match(/documents\/\S+\.pptx/)?.[0] ?? '')))
      return zip.files['ppt/slides/slide1.xml'].async('string')
    }

    it('crops a picture to fill its box by default instead of stretching it, and can letterbox or stretch on request', async () => {
      await writeFile(join(root, 'wide.png'), Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([0, 0, 7, 128, 0, 0, 3, 232]), Buffer.alloc(8)])) // 1920 x 1000
      const cover = await savedSlideXml([{ type: 'image', path: 'wide.png', x: 0, y: 0, w: 5, h: 5 }])
      expect(cover).toMatch(/<a:srcRect/) // cropped to a square from a 1.92:1 picture
      const stretch = await savedSlideXml([{ type: 'image', path: 'wide.png', fit: 'stretch', x: 0, y: 0, w: 5, h: 5 }])
      expect(stretch).not.toMatch(/<a:srcRect/)
    })

    it('draws a semi-transparent shape, so text over a photo stays readable', async () => {
      const xml = await savedSlideXml([{ type: 'shape', shape: 'rect', fill: '000000', transparency: 45, x: 0, y: 3, w: 10, h: 2.6 }])
      expect(xml).toMatch(/<a:alpha val="55000"\/>/)
    })
  })

  describe('fonts and slide background (the gap that sent a model to python-pptx)', () => {
    it('writes the requested font family, italics and slide colour into the saved file', async () => {
      const deckId = /"([^"]+)"/.exec(await pptxStartDeckTool.execute({}, ctx))?.[1]
      await pptxAddSlideTool.execute({ deckId }, ctx)
      await pptxComposeSlideTool.execute(
        { deckId, background: '0F172A', elements: [{ type: 'text', text: 'Styled', fontFace: 'Georgia', italic: true, valign: 'middle', x: 1, y: 1, w: 5, h: 1 }] },
        ctx
      )
      const saved = String(await pptxSaveDeckTool.execute({ deckId, path: 'styled.pptx' }, ctx))
      const rel = saved.match(/documents\/\S+\.pptx/)?.[0] ?? ''
      const { default: JSZip } = await import('jszip')
      const zip = await JSZip.loadAsync(await (await import('node:fs/promises')).readFile(join(root, rel)))
      const xml = await zip.files['ppt/slides/slide1.xml'].async('string')
      expect(xml).toContain('Georgia')
      expect(xml).toMatch(/i="1"/)
      expect(xml).toMatch(/0F172A/i)
    })
  })

  describe('element geometry (found live: a deck whose every element piled up in the corner)', () => {
    async function composeOne(element: Record<string, unknown>): Promise<string> {
      const deckId = /"([^"]+)"/.exec(await pptxStartDeckTool.execute({}, ctx))?.[1]
      await pptxAddSlideTool.execute({ deckId }, ctx)
      return pptxComposeSlideTool.execute({ deckId, elements: [element] }, ctx)
    }

    it('reads left/top/width/height and numeric strings as x/y/w/h, and says it did', async () => {
      const out = await composeOne({ type: 'text', text: 'Hi', left: 0.8, top: '0.8', width: 8.4, height: 1 })
      expect(out).toContain('with 1 element(s)')
      expect(out).toContain('1 element(s) had a missing or malformed "type"')
    })

    it('rejects an element with no position at all instead of silently defaulting it to the corner', async () => {
      await expect(composeOne({ type: 'text', text: 'Hi', fontSize: 20 })).rejects.toThrow(/needs a numeric "x" \(x, y, w and h in inches/)
      await expect(composeOne({ type: 'text', text: 'Hi', x: 1, y: 1, w: 3 })).rejects.toThrow(/needs a numeric "h"/)
    })

    it('rejects a zero or negative size (a flat line is the one exception) and anything running off the 10 x 5.625 in slide', async () => {
      await expect(composeOne({ type: 'text', text: 'Hi', x: 1, y: 1, w: 3, h: 0 })).rejects.toThrow(/greater than 0/)
      await expect(composeOne({ type: 'shape', shape: 'line', x: 1, y: 2, w: 5, h: 0 })).resolves.toContain('with 1 element(s)')
      await expect(composeOne({ type: 'text', text: 'Hi', x: 1, y: 5, w: 3, h: 1.5 })).rejects.toThrow(/runs off the slide: a slide is 10 x 5\.625 inches/)
      await expect(composeOne({ type: 'text', text: 'Hi', x: 8, y: 1, w: 3, h: 1 })).rejects.toThrow(/runs off the slide/)
      await expect(composeOne({ type: 'text', text: 'Hi', x: 0.5, y: 4.4, w: 9, h: 1.2 })).resolves.toContain('with 1 element(s)')
    })

    it('a rejected element leaves the slide untouched, so a corrected retry does not duplicate anything', async () => {
      const deckId = /"([^"]+)"/.exec(await pptxStartDeckTool.execute({}, ctx))?.[1]
      await pptxAddSlideTool.execute({ deckId }, ctx)
      await expect(pptxComposeSlideTool.execute({ deckId, elements: [{ type: 'text', text: 'ok', x: 1, y: 1, w: 3, h: 1 }, { type: 'text', text: 'bad', fontSize: 9 }] }, ctx)).rejects.toThrow()
      await pptxComposeSlideTool.execute({ deckId, elements: [{ type: 'text', text: 'ok', x: 1, y: 1, w: 3, h: 1 }] }, ctx)
      const out = String(await pptxSaveDeckTool.execute({ deckId, path: 'once.pptx' }, ctx))
      const text = await officeReadDocumentTool.execute({ path: out.match(/documents\/\S+\.pptx/)?.[0] ?? 'documents/once.pptx' }, ctx)
      expect(String(text).match(/ok/g)).toHaveLength(1)
    })
  })

  describe('recovering a corrupted element type (found live: the roadmap deck loop)', () => {
    const el = { x: 1, y: 1, w: 4, h: 1 }

    it('keeps a valid type as is, recovers a valid leading word from a garbled one, and infers a missing one from the other fields', () => {
      expect(normalizeElement({ ...el, type: 'text', text: 'a' })).toMatchObject({ corrected: false })
      expect(normalizeElement({ ...el, type: 'text,x:1.1,y:2.55,w:0.9,h:0.4},{align:', text: 'Q1' })).toMatchObject({ corrected: true, element: { type: 'text', text: 'Q1' } })
      expect(normalizeElement({ ...el, shape: 'roundRect', fill: 'F8FAFC' })).toMatchObject({ corrected: true, element: { type: 'shape' } })
      expect(normalizeElement({ ...el, text: 'plain' })).toMatchObject({ corrected: true, element: { type: 'text' } })
      expect(normalizeElement({ ...el, path: 'resources/a.png' })).toMatchObject({ element: { type: 'image' } })
      expect(normalizeElement({ ...el, rows: [['a']] })).toMatchObject({ element: { type: 'table' } })
      expect(normalizeElement({ ...el, chartType: 'bar', series: [] })).toMatchObject({ element: { type: 'chart' } })
    })

    it('leaves what it cannot place alone, so validation still reports the real problem', () => {
      expect(normalizeElement({ ...el, type: '???' })).toMatchObject({ corrected: false })
      expect(normalizeElement('nonsense')).toMatchObject({ corrected: false })
    })

    it('composes a slide from the actual garbled calls instead of failing, and says it corrected them', async () => {
      const deckId = /"([^"]+)"/.exec(await pptxStartDeckTool.execute({}, ctx))?.[1]
      await pptxAddSlideTool.execute({ deckId }, ctx)
      const out = await pptxComposeSlideTool.execute(
        {
          deckId,
          elements: [
            { x: 0.8, y: 0.8, w: 8.4, h: 1.2, shape: 'roundRect', fill: 'F8FAFC', line: 'CBD5E1' },
            { x: 0.8, y: 2.4, w: 8.4, h: 0.8, type: 'text,x:1.2,y:1.1,w:7.6,h:0.6},{fill:', text: 'Roadmap Overview', fontSize: 26 }
          ]
        },
        ctx
      )
      expect(out).toContain('with 2 element(s)')
      expect(out).toContain('2 element(s) had a missing or malformed "type" and were corrected')
    })

    it('still rejects an element with nothing to infer a type from, with a message that says what to do', async () => {
      const deckId = /"([^"]+)"/.exec(await pptxStartDeckTool.execute({}, ctx))?.[1]
      await pptxAddSlideTool.execute({ deckId }, ctx)
      await expect(pptxComposeSlideTool.execute({ deckId, elements: [{ x: 1, y: 1, w: 1, h: 1, color: '000000' }] }, ctx)).rejects.toThrow(/Unknown element type "undefined" — every element needs "type" set to exactly one of/)
    })
  })
})
