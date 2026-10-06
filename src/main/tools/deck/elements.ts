import { readFileSync } from 'node:fs'
import { access } from 'node:fs/promises'
import type pptxgen from 'pptxgenjs'
import type { ToolContext } from '../types'
import { readImageSize } from './image-size'

const VALID_ELEMENT_TYPES = ['text', 'image', 'shape', 'chart', 'table'] as const

/** The real slide size, in inches: pptxgenjs's default 16:9 layout. (The tool text used to say 10x7.5, which is 4:3 — content laid out for that ran off the bottom.) */
export const SLIDE_WIDTH_IN = 10
export const SLIDE_HEIGHT_IN = 5.625
const EDGE_TOLERANCE_IN = 0.05

const GEOMETRY_ALIASES: Record<string, 'x' | 'y' | 'w' | 'h'> = { left: 'x', top: 'y', width: 'w', height: 'h' }

/**
 * A deliberately simplified, flat element schema for `pptx_compose_slide` —
 * page-creator expresses a whole slide's design as one array of these
 * instead of pptxgenjs's own considerably richer (and more verbose) option
 * shapes, keeping the model-facing tool interface easy to generate
 * correctly in one structured call (see #78's "round economy via tool
 * shape" design point). Positions/sizes are in inches, matching
 * pptxgenjs's own default unit and the 10x5.625in (16:9) slide.
 */
export interface SlideElementInput {
  type: 'text' | 'image' | 'shape' | 'chart' | 'table'
  x: number
  y: number
  w: number
  h: number
  // text
  text?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  /** A font family name, e.g. "Calibri", "Georgia", "Segoe UI". */
  fontFace?: string
  color?: string
  align?: 'left' | 'center' | 'right'
  valign?: 'top' | 'middle' | 'bottom'
  bullet?: boolean
  // image
  path?: string
  /** How a picture fills its box: "cover" (default) crops to fill without distorting, "contain" shows all of it with empty margins, "stretch" distorts it to fit. */
  fit?: 'cover' | 'contain' | 'stretch'
  // shape
  shape?: string
  fill?: string
  line?: string
  /** 0 (solid) to 100 (invisible): a semi-transparent shape over a photo keeps text on it readable. */
  transparency?: number
  // chart
  chartType?: string
  categories?: string[]
  series?: { name: string; values: number[] }[]
  // table
  rows?: string[][]
}

/**
 * A weak model's tool call sometimes comes out corrupted: found live (the 3-slide roadmap deck), a model's `type`
 * field swallowed the fields after it ("text,x:1.1,y:2.55,w:0.9,h:0.4},{align:") or went missing, and it then repeated
 * the same broken call 30+ times. The element's other fields still say what it is, so recover the type: a valid
 * leading word of a garbled `type`, else inferred from which fields are present. Returns `corrected: false` when
 * nothing needed (or nothing could be) fixed — validation then reports the real problem.
 */
export function normalizeElement(raw: unknown): { element: SlideElementInput; corrected: boolean } {
  const original = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  // Found live: a model wrote left/top/width/height for x/y/w/h, the unknown names were silently ignored, and every
  // element of a whole deck piled up in the corner. Map the obvious synonyms, and read numeric strings as numbers.
  let el: Record<string, unknown> = original
  let geometryFixed = false
  for (const [alias, canonical] of Object.entries(GEOMETRY_ALIASES)) {
    if (el[canonical] === undefined && el[alias] !== undefined) {
      el = { ...el, [canonical]: el[alias] }
      delete el[alias]
      geometryFixed = true
    }
  }
  for (const key of ['x', 'y', 'w', 'h'] as const) {
    if (typeof el[key] === 'string' && el[key] !== '' && Number.isFinite(Number(el[key]))) {
      el = { ...el, [key]: Number(el[key]) }
      geometryFixed = true
    }
  }
  const valid = VALID_ELEMENT_TYPES as readonly string[]
  if (typeof el.type === 'string' && valid.includes(el.type)) return { element: el as unknown as SlideElementInput, corrected: geometryFixed }
  const lead = typeof el.type === 'string' ? /^\s*([a-z]+)/i.exec(el.type)?.[1]?.toLowerCase() : undefined
  const inferred =
    lead && valid.includes(lead)
      ? lead
      : el.path
        ? 'image'
        : Array.isArray(el.rows)
          ? 'table'
          : el.chartType || Array.isArray(el.series)
            ? 'chart'
            : el.shape
              ? 'shape'
              : el.text !== undefined
                ? 'text'
                : undefined
  if (!inferred) return { element: el as unknown as SlideElementInput, corrected: geometryFixed }
  return { element: { ...el, type: inferred } as unknown as SlideElementInput, corrected: true }
}

/**
 * A model writing a multi-line value into JSON often emits the two characters backslash and n (an escape that got
 * escaped again) instead of a line break, and the slide then shows a literal "\n" in the middle of its text — found
 * live in the Project Aurora deck. Turn those into real line breaks; also normalise Windows line endings.
 */
export function withRealLineBreaks(text: string): string {
  return text.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\r\n?/g, '\n')
}

function addTextElement(slide: pptxgen.Slide, el: SlideElementInput): void {
  slide.addText(withRealLineBreaks(String(el.text ?? '')), {
    x: el.x,
    y: el.y,
    w: el.w,
    h: el.h,
    fontSize: el.fontSize,
    bold: el.bold,
    italic: el.italic,
    fontFace: typeof el.fontFace === 'string' && el.fontFace.trim() ? el.fontFace.trim() : undefined,
    color: el.color,
    align: el.align,
    valign: el.valign,
    bullet: el.bullet ? true : undefined
  })
}

function addImageElement(slide: pptxgen.Slide, el: SlideElementInput, ctx: ToolContext): void {
  if (!el.path) throw new Error('An "image" element needs a "path".')
  const absPath = ctx.workspaceGuard.assertWithinWorkspace(el.path)
  const fit = el.fit === 'contain' || el.fit === 'stretch' ? el.fit : 'cover'
  // A picture stretched to an arbitrary box is distorted. Crop it to fill ("cover") or letterbox it ("contain") using its
  // real proportions; only when those cannot be read (an unknown format) fall back to stretching.
  let size: { width: number; height: number } | undefined
  try {
    size = fit === 'stretch' ? undefined : readImageSize(readFileSync(absPath))
  } catch {
    size = undefined
  }
  if (size && size.width > 0 && size.height > 0) {
    slide.addImage({ path: absPath, x: el.x, y: el.y, w: size.width / 96, h: size.height / 96, sizing: { type: fit === 'contain' ? 'contain' : 'cover', w: el.w, h: el.h } })
  } else {
    slide.addImage({ path: absPath, x: el.x, y: el.y, w: el.w, h: el.h })
  }
}

function addShapeElement(slide: pptxgen.Slide, el: SlideElementInput): void {
  if (!el.shape) throw new Error('A "shape" element needs a "shape" name (e.g. "rect", "roundRect", "oval", "line").')
  slide.addShape(el.shape as pptxgen.SHAPE_NAME, {
    x: el.x,
    y: el.y,
    w: el.w,
    h: el.h,
    fill: el.fill ? { color: el.fill, transparency: typeof el.transparency === 'number' ? Math.min(100, Math.max(0, el.transparency)) : undefined } : undefined,
    line: el.line ? { color: el.line } : undefined
  })
}

function addChartElement(slide: pptxgen.Slide, el: SlideElementInput): void {
  if (!el.chartType) throw new Error('A "chart" element needs a "chartType" (e.g. "bar", "line", "pie").')
  const series = el.series ?? []
  if (series.length === 0) throw new Error('A "chart" element needs at least one entry in "series".')
  const data = series.map((s) => ({ name: s.name, labels: el.categories ?? [], values: s.values }))
  slide.addChart(el.chartType as pptxgen.CHART_NAME, data, { x: el.x, y: el.y, w: el.w, h: el.h })
}

function addTableElement(slide: pptxgen.Slide, el: SlideElementInput): void {
  const rows = el.rows ?? []
  if (rows.length === 0) throw new Error('A "table" element needs at least one row in "rows".')
  slide.addTable(
    rows.map((row) => row.map((cell) => ({ text: withRealLineBreaks(String(cell)) }))),
    { x: el.x, y: el.y, w: el.w, h: el.h }
  )
}

/**
 * Checks one element is well-formed *without* touching the slide — including,
 * for an image, that the file actually exists. pptxgenjs itself only reads
 * image files at `writeFile()` time (pptx_save_deck), so without this check
 * a hallucinated icon path would silently "succeed" at compose time and only
 * fail much later, far from the mistake, as a generic ENOENT at save. Callers
 * must validate every element in a slide's array before applying any of them
 * (see pptx_compose_slide), so one bad element can't leave the rest applied.
 */
function checkGeometry(el: SlideElementInput): void {
  const label = `A "${String(el.type)}" element`
  for (const key of ['x', 'y', 'w', 'h'] as const) {
    if (typeof el[key] !== 'number' || !Number.isFinite(el[key])) {
      throw new Error(`${label} needs a numeric "${key}" (x, y, w and h in inches — not left/top/width/height); without it the element lands at a default position and the slide turns into a pile.`)
    }
  }
  // A line may be flat (w or h of 0); everything else needs a real size.
  const flatOk = el.type === 'shape' && el.shape === 'line'
  if (!flatOk && (el.w <= 0 || el.h <= 0)) throw new Error(`${label} needs a "w" and "h" greater than 0.`)
  if (el.x < -EDGE_TOLERANCE_IN || el.y < -EDGE_TOLERANCE_IN || el.x + el.w > SLIDE_WIDTH_IN + EDGE_TOLERANCE_IN || el.y + el.h > SLIDE_HEIGHT_IN + EDGE_TOLERANCE_IN) {
    throw new Error(
      `${label} at x=${el.x}, y=${el.y}, w=${el.w}, h=${el.h} runs off the slide: a slide is ${SLIDE_WIDTH_IN} x ${SLIDE_HEIGHT_IN} inches ` +
        `(so x+w must be at most ${SLIDE_WIDTH_IN} and y+h at most ${SLIDE_HEIGHT_IN}). Lay it out again within those bounds.`
    )
  }
}

export async function validateElement(el: SlideElementInput, ctx: ToolContext): Promise<void> {
  checkGeometry(el)
  switch (el.type) {
    case 'text':
      return
    case 'image': {
      if (!el.path) throw new Error('An "image" element needs a "path".')
      const absPath = ctx.workspaceGuard.assertWithinWorkspace(el.path)
      try {
        await access(absPath)
      } catch {
        throw new Error(
          `Image element's "path" ("${el.path}") does not exist in the workspace. There is no icon/image ` +
            'generator available — only reference a file that has actually been created or uploaded. Use a ' +
            '"shape" or "text" element instead if no suitable image file exists.'
        )
      }
      return
    }
    case 'shape':
      if (!el.shape) throw new Error('A "shape" element needs a "shape" name (e.g. "rect", "roundRect", "oval", "line").')
      return
    case 'chart':
      if (!el.chartType) throw new Error('A "chart" element needs a "chartType" (e.g. "bar", "line", "pie").')
      if ((el.series ?? []).length === 0) throw new Error('A "chart" element needs at least one entry in "series".')
      return
    case 'table':
      if ((el.rows ?? []).length === 0) throw new Error('A "table" element needs at least one row in "rows".')
      return
    default:
      throw new Error(
        `Unknown element type "${String((el as { type?: unknown }).type)}" — every element needs "type" set to exactly one of: ${VALID_ELEMENT_TYPES.join(', ')} (just the word, with no other fields inside it).`
      )
  }
}

/** Applies one element to a real slide — throws a clear, element-specific error rather than a generic pptxgenjs failure when required fields are missing. Call validateElement on every element in a batch first; this does not re-check image existence. */
export function applyElement(slide: pptxgen.Slide, el: SlideElementInput, ctx: ToolContext): void {
  switch (el.type) {
    case 'text':
      return addTextElement(slide, el)
    case 'image':
      return addImageElement(slide, el, ctx)
    case 'shape':
      return addShapeElement(slide, el)
    case 'chart':
      return addChartElement(slide, el)
    case 'table':
      return addTableElement(slide, el)
    default:
      throw new Error(`Unknown element type "${String((el as { type?: unknown }).type)}".`)
  }
}
