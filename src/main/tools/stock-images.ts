import { recordKnownUrl } from './data-formats/link-registry'
import { FETCH_USER_AGENT } from './data-formats/source'
import type { Tool, ToolContext } from './types'

const OPENVERSE_IMAGES = 'https://api.openverse.org/v1/images/'
const TIMEOUT_MS = 20_000
const DEFAULT_COUNT = 6
const MAX_COUNT = 10
/** Anything smaller looks soft or pixelated filling a slide. */
const MIN_WIDTH_PX = 800

interface OpenverseImage {
  title?: string
  url?: string
  thumbnail?: string
  width?: number
  height?: number
  creator?: string
  license?: string
  license_version?: string
  provider?: string
  foreign_landing_url?: string
}

/** "by" + "2.0" -> "CC BY 2.0", "cc0" -> "CC0", "pdm" -> "Public Domain". */
export function licenceLabel(license: string | undefined, version: string | undefined): string {
  const l = (license ?? '').toLowerCase()
  if (l === 'cc0') return 'CC0'
  if (l === 'pdm') return 'Public Domain'
  return l ? `CC ${l.toUpperCase()}${version ? ` ${version}` : ''}` : 'licence unknown'
}

/** A Wikimedia original can be tens of megabytes; its served thumbnail is the sensible download. Everything else serves a usable file at `url`. */
function downloadUrlFor(image: OpenverseImage): string | undefined {
  const wikimedia = (image.provider ?? '').startsWith('wikimedia')
  return (wikimedia ? image.thumbnail : image.url) || image.url || image.thumbnail
}

export const findStockImagesTool: Tool = {
  name: 'find_stock_images',
  description:
    'Find free stock photos for a topic (Openverse; no key needed): direct image URLs with creator and licence, ready for ' +
    'download_image. Use short, concrete visual queries ("data center servers", "team meeting office", "wind turbines at ' +
    'sunset"), not abstract ideas. Each result carries a credit line to put on the slide.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What the picture should show' },
      queries: { type: 'array', items: { type: 'string' }, description: 'Several different pictures at once (up to 8) — one call for a whole deck instead of one per slide' },
      count: { type: 'number', description: `How many to return (default ${DEFAULT_COUNT}, max ${MAX_COUNT})` },
      orientation: { type: 'string', enum: ['wide', 'tall', 'square'], description: 'Default wide, which suits a slide' }
    },
    required: []
  },
  mutates: false,
  async execute(input, ctx) {
    const many = Array.isArray(input.queries) ? input.queries.map((q) => String(q).trim()).filter(Boolean).slice(0, 8) : []
    if (many.length > 0) {
      const parts: string[] = []
      for (const q of many) parts.push(await searchOne({ ...input, query: q, queries: undefined }, ctx))
      return parts.join('\n\n')
    }
    return searchOne(input, ctx)
  }
}

async function searchOne(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  {
    const query = String(input.query ?? '').trim()
    if (!query) throw new Error('No query given.')
    const count = Math.min(MAX_COUNT, Math.max(1, Number(input.count) || DEFAULT_COUNT))
    const orientation = input.orientation === 'tall' || input.orientation === 'square' ? input.orientation : 'wide'

    const params = new URLSearchParams({
      q: query,
      page_size: String(Math.min(20, count * 3)),
      license_type: 'commercial',
      mature: 'false',
      category: 'photograph',
      aspect_ratio: orientation
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    let results: OpenverseImage[]
    try {
      const response = await fetch(`${OPENVERSE_IMAGES}?${params}`, { signal: controller.signal, headers: { 'User-Agent': FETCH_USER_AGENT, Accept: 'application/json' } })
      if (!response.ok) throw new Error(`Stock image search failed: ${response.status} ${response.statusText}`)
      results = ((await response.json()) as { results?: OpenverseImage[] }).results ?? []
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw new Error(`Stock image search timed out after ${TIMEOUT_MS / 1000}s.`)
      throw err
    } finally {
      clearTimeout(timer)
    }

    const usable = results.filter((r) => downloadUrlFor(r) && (r.width ?? 0) >= MIN_WIDTH_PX).slice(0, count)
    if (usable.length === 0) return `No stock photos found for "${query}". Try a shorter, more concrete query (what is physically in the picture).`
    const lines = usable.map((r, i) => {
      const url = downloadUrlFor(r) as string
      if (r.url) recordKnownUrl(ctx.currentSessionId, r.url)
      if (r.thumbnail) recordKnownUrl(ctx.currentSessionId, r.thumbnail)
      const licence = licenceLabel(r.license, r.license_version)
      const creator = (r.creator ?? '').trim() || 'unknown'
      const title = (r.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled'
      return `${i + 1}. ${url}\n   "${title}" — ${r.width}x${r.height}, ${r.provider ?? 'unknown source'}. Credit: Photo: ${creator} (${licence})`
    })
    return `${usable.length} stock photo(s) for "${query}" — download one with download_image; use a different photo on every slide and put its credit line, small, on that slide:\n${lines.join('\n')}`
  }
}
