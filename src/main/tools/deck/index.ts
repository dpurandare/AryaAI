import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import pptxgen from 'pptxgenjs'
import type { Tool, ToolContext } from '../types'
import { resolveNewFilePath, workspaceRelativePath } from '../workspace-layout'
import { applyElement, normalizeElement, validateElement, withRealLineBreaks } from './elements'
import { fixDeckPackage } from './package-fix'

type DeckState = NonNullable<ToolContext['activeDecks']> extends Map<string, infer D> ? D : never

function requireDecks(ctx: ToolContext): Map<string, DeckState> {
  if (!ctx.activeDecks) throw new Error('Deck tools are unavailable in this context.')
  return ctx.activeDecks
}

/**
 * `deckId` is optional everywhere on purpose — live-tested against a real
 * local model and found genuinely fragile: an opaque id has to survive
 * `pptx_start_deck`'s result -> the top-level's own free-text task handed
 * to `delegate_to_page-creator` -> the isolated specialist's own tool
 * call, and a real run showed the model guessing plausible-looking
 * placeholders ("deck1", "mydeck") instead of copying the real id
 * correctly, twice. Since a turn almost always builds exactly one deck at
 * a time, defaulting to "the only active deck" when `deckId` is omitted
 * sidesteps needing that id to round-trip through natural language at
 * all in the common case — only a genuinely ambiguous multi-deck turn
 * needs to specify it explicitly.
 */
function resolveDeckId(ctx: ToolContext, deckId: string | undefined): string {
  const decks = requireDecks(ctx)
  if (deckId) return deckId
  if (decks.size === 1) return [...decks.keys()][0]
  if (decks.size === 0) throw new Error('No deck is in progress — call pptx_start_deck first.')
  throw new Error(`Multiple decks are in progress (${[...decks.keys()].join(', ')}) — specify deckId explicitly.`)
}

function requireDeck(ctx: ToolContext, deckId: string | undefined): DeckState & { id: string } {
  const id = resolveDeckId(ctx, deckId)
  const deck = requireDecks(ctx).get(id)
  if (!deck) throw new Error(`Unknown deck "${id}" — call pptx_start_deck first.`)
  return { ...deck, id }
}

export const pptxStartDeckTool: Tool = {
  name: 'pptx_start_deck',
  description:
    'Start a new, empty presentation in memory (#78). Returns a deckId — use it with pptx_add_slide, ' +
    "delegate_to_page-creator, and pptx_save_deck for the rest of this deck. Give slides: N to create all N empty " +
    'slides now (indexes 0..N-1) instead of one pptx_add_slide call each — then give every slide\'s index in its brief. ' +
    'Nothing is written to disk until pptx_save_deck.',
  inputSchema: { type: 'object', properties: { slides: { type: 'number', description: 'How many empty slides to create now (1-40)' } } },
  mutates: false,
  async execute(input, ctx) {
    const decks = requireDecks(ctx)
    const deckId = randomUUID().slice(0, 8)
    const pres = new pptxgen()
    pres.layout = 'LAYOUT_16x9' // 10 x 5.625 in — the size every element position is checked against
    const slides: ReturnType<typeof pres.addSlide>[] = []
    const wanted = Math.min(40, Math.max(0, Math.floor(Number(input.slides) || 0)))
    for (let i = 0; i < wanted; i++) slides.push(pres.addSlide())
    decks.set(deckId, { pres, slides, composed: wanted ? new Set() : undefined })
    return wanted ? `Started deck "${deckId}" with ${wanted} empty slides (indexes 0 to ${wanted - 1}).` : `Started deck "${deckId}".`
  }
}

export const pptxAddSlideTool: Tool = {
  name: 'pptx_add_slide',
  description:
    'Add a new, empty slide to the in-progress deck (from pptx_start_deck — deckId only needs to be ' +
    "given if more than one deck is in progress at once). Returns the slide's index — hand that index to " +
    'delegate_to_page-creator, along with a brief for what should go on it (heading, key content/data ' +
    'points, tone/style notes), one call per slide.',
  inputSchema: {
    type: 'object',
    properties: { deckId: { type: 'string', description: 'Only needed if more than one deck is in progress' } }
  },
  mutates: false,
  async execute(input, ctx) {
    const deck = requireDeck(ctx, typeof input.deckId === 'string' ? input.deckId : undefined)
    const slide = deck.pres.addSlide()
    deck.slides.push(slide)
    const slideIndex = deck.slides.length - 1
    return `Added slide ${slideIndex} to deck "${deck.id}".`
  }
}

/** What the slide now says, quoted — so the specialist and the router report what is really on it, not what they meant to put there. */
function textOnSlide(elements: Array<{ type: string; text?: unknown }>): string {
  const texts = elements.filter((e) => e.type === 'text' && typeof e.text === 'string' && e.text.trim()).map((e) => withRealLineBreaks(String(e.text)).replace(/\s+/g, ' ').trim().slice(0, 70))
  return texts.length ? ` Text on the slide: ${texts.map((t) => `"${t}"`).join(' | ')}.` : ''
}

export const pptxComposeSlideTool: Tool = {
  name: 'pptx_compose_slide',
  description:
    'Fill a slide with your visual design for it — an array of elements, each an object with a "type" ' +
    '(text/image/shape/chart/table) plus x/y/w/h in inches (slide 10x5.625in; numeric x,y,w,h required). deckId/slideIndex are ' +
    'usually given to you in your task brief; if you were not told them, or are unsure, omit both — this ' +
    'defaults to the most recently added slide of the only deck in progress, which is correct for the ' +
    'normal one-slide-per-call flow. background? (hex, no #) sets the slide colour. text: {type:"text", text, x,y,w,h, fontSize?, bold?, italic?, fontFace?, color? (hex, ' +
    'no #), align? ("left"/"center"/"right"), valign? ("top"/"middle"/"bottom"), bullet?}. image: {type:"image", path (workspace-relative), ' +
    'x,y,w,h}. shape: {type:"shape", shape (e.g. "rect","roundRect","ellipse","line"), x,y,w,h, fill? (hex), ' +
    'line? (hex)}. chart: {type:"chart", chartType ("bar"/"line"/"pie"/"doughnut"/"area"/"radar"), ' +
    'categories (string[]), series ([{name, values: number[]}]), x,y,w,h}. table: {type:"table", rows ' +
    '(string[][]), x,y,w,h}. Express the whole slide as one call, not one element per call.',
  inputSchema: {
    type: 'object',
    properties: {
      deckId: { type: 'string', description: 'Only needed if more than one deck is in progress' },
      slideIndex: { type: 'number', description: 'Only needed if unsure which slide — defaults to the most recently added' },
      background: { type: 'string', description: 'Slide background colour, hex without #' },
      elements: { type: 'array', items: { type: 'object' } }
    },
    required: ['elements']
  },
  mutates: false,
  async execute(input, ctx) {
    const deck = requireDeck(ctx, typeof input.deckId === 'string' ? input.deckId : undefined)
    // No index given: the most recently added slide — or, for a deck started with all its slides at once, the first one still empty.
    const firstEmpty = deck.composed ? deck.slides.findIndex((_, i) => !deck.composed?.has(i)) : -1
    const slideIndex = typeof input.slideIndex === 'number' ? input.slideIndex : firstEmpty >= 0 ? firstEmpty : deck.slides.length - 1
    const slide = deck.slides[slideIndex]
    if (!slide) {
      throw new Error(`Deck "${deck.id}" has no slide at index ${slideIndex}. Call pptx_add_slide first.`)
    }
    const given = Array.isArray(input.elements) ? (input.elements as unknown[]) : []
    if (given.length === 0) throw new Error('"elements" must be a non-empty array.')
    // Recover an element whose "type" came out missing or garbled from the fields it does have (see normalizeElement).
    const normalized = given.map(normalizeElement)
    const elements = normalized.map((n) => n.element)
    const correctedCount = normalized.filter((n) => n.corrected).length

    // Validate every element before applying any of them — a slide is not
    // undoable once mutated (pptxgenjs has no remove-element API), so a
    // single bad element partway through the array used to leave the earlier
    // ones permanently applied; a corrected retry then duplicated them.
    for (const el of elements) await validateElement(el, ctx)
    for (const el of elements) applyElement(slide, el, ctx)
    requireDecks(ctx).get(deck.id)?.composed?.add(slideIndex)
    if (typeof input.background === 'string' && /^#?[0-9a-fA-F]{6}$/.test(input.background.trim())) slide.background = { color: input.background.trim().replace(/^#/, '') }

    return (
      `Composed slide ${slideIndex} of deck "${deck.id}" with ${elements.length} element(s).` +
      textOnSlide(elements) +
      (correctedCount ? ` (${correctedCount} element(s) had a missing or malformed "type" and were corrected from their other fields — set "type" to exactly one word next time.)` : '')
    )
  }
}

export const pptxSaveDeckTool: Tool = {
  name: 'pptx_save_deck',
  description:
    'Write the in-progress deck to a real .pptx file in the workspace and discard it from memory (deckId ' +
    'only needs to be given if more than one deck is in progress). Call this once, after every planned ' +
    'slide has been composed. A brand-new file is placed under documents/ automatically regardless of the ' +
    'path given, unless a file already exists there (then it writes back to that existing location instead) ' +
    '— the result names the real path used.',
  inputSchema: {
    type: 'object',
    properties: {
      deckId: { type: 'string', description: 'Only needed if more than one deck is in progress' },
      path: { type: 'string', description: 'Output path relative to the workspace root, .pptx' }
    },
    required: ['path']
  },
  mutates: true,
  describe(input) {
    return `Save deck to "${String(input.path ?? '')}"`
  },
  async execute(input, ctx) {
    const deck = requireDeck(ctx, typeof input.deckId === 'string' ? input.deckId : undefined)
    const relPath = String(input.path ?? '')
    const absPath = resolveNewFilePath(ctx.workspaceGuard, relPath)
    await mkdir(dirname(absPath), { recursive: true })
    await deck.pres.writeFile({ fileName: absPath })
    await fixDeckPackage(absPath)
    requireDecks(ctx).delete(deck.id)
    const savedRelPath = workspaceRelativePath(ctx.workspaceGuard.root, absPath)
    return `Saved ${savedRelPath} (${deck.slides.length} slide(s)).`
  }
}
