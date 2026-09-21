import type pptxgen from 'pptxgenjs'
import type { ToolContext } from '../types'

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

/** Applies one element to a real slide — throws a clear, element-specific error rather than a generic pptxgenjs failure when required fields are missing. */
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
