import { access } from 'node:fs/promises'
import type pptxgen from 'pptxgenjs'
import type { ToolContext } from '../types'

const VALID_ELEMENT_TYPES = ['text', 'image', 'shape', 'chart', 'table'] as const

/**
 * A deliberately simplified, flat element schema for `pptx_compose_slide` —
 * page-creator expresses a whole slide's design as one array of these
 * instead of pptxgenjs's own considerably richer (and more verbose) option
 * shapes, keeping the model-facing tool interface easy to generate
 * correctly in one structured call (see #78's "round economy via tool
 * shape" design point). Positions/sizes are in inches, matching
 * pptxgenjs's own default unit and a standard 10x7.5in slide.
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
  color?: string
  align?: 'left' | 'center' | 'right'
  bullet?: boolean
  // image
  path?: string
  // shape
  shape?: string
  fill?: string
  line?: string
  // chart
  chartType?: string
  categories?: string[]
  series?: { name: string; values: number[] }[]
  // table
  rows?: string[][]
}

function addTextElement(slide: pptxgen.Slide, el: SlideElementInput): void {
  slide.addText(String(el.text ?? ''), {
    x: el.x,
    y: el.y,
    w: el.w,
    h: el.h,
    fontSize: el.fontSize,
    bold: el.bold,
    color: el.color,
    align: el.align,
    bullet: el.bullet ? true : undefined
  })
}

function addImageElement(slide: pptxgen.Slide, el: SlideElementInput, ctx: ToolContext): void {
  if (!el.path) throw new Error('An "image" element needs a "path".')
  const absPath = ctx.workspaceGuard.assertWithinWorkspace(el.path)
  slide.addImage({ path: absPath, x: el.x, y: el.y, w: el.w, h: el.h })
}

function addShapeElement(slide: pptxgen.Slide, el: SlideElementInput): void {
  if (!el.shape) throw new Error('A "shape" element needs a "shape" name (e.g. "rect", "roundRect", "oval", "line").')
  slide.addShape(el.shape as pptxgen.SHAPE_NAME, {
    x: el.x,
    y: el.y,
    w: el.w,
    h: el.h,
    fill: el.fill ? { color: el.fill } : undefined,
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
    rows.map((row) => row.map((cell) => ({ text: cell }))),
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
export async function validateElement(el: SlideElementInput, ctx: ToolContext): Promise<void> {
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
        `Unknown element type "${String((el as { type?: unknown }).type)}" — must be one of: ${VALID_ELEMENT_TYPES.join(', ')}.`
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
