import { readFile } from 'node:fs/promises'
import type { ToolContext } from '../types'

const FETCH_TIMEOUT_MS = 30_000
/** Generous compared to read_file's 200KB cap — that number exists because its content goes straight to the model; a data-format tool processes the file itself and only sends a condensed result, so the risk here is a pathological load, not context bloat. */
export const MAX_SOURCE_BYTES = 5_000_000

export interface SourceInput {
  url?: unknown
  filePath?: unknown
  text?: unknown
}

export interface ResolvedSource {
  text: string
  /** Only set when the source was `filePath` — the one case `append` (parse_csv/parse_json) can write back to. */
  writeBackPath?: string
}

/**
 * A model that fills in every schema property rather than omitting unused
 * optional ones (confirmed live: gpt-oss passed url alongside filePath: ""
 * and text: "" in the same call) shouldn't get a confusing "3 given"
 * rejection for what is, in intent, a single real argument — an empty
 * string counts the same as not provided at all, here and in every branch
 * below that checks a specific field.
 */
function isGiven(value: unknown): boolean {
  return value !== undefined && value !== ''
}

/** Shared by every data-format tool (parse_html/parse_csv/parse_json/parse_xml): exactly one of `url` (tool fetches it directly, so the raw content never has to pass through the model's own context first), `filePath` (workspace-relative), or `text` (inline, for content already small enough to be in context). */
export async function resolveSource(input: SourceInput, ctx: ToolContext): Promise<ResolvedSource> {
  const given = (['url', 'filePath', 'text'] as const).filter((k) => isGiven(input[k]))
  if (given.length !== 1) {
    throw new Error(`Provide exactly one of url, filePath, or text (got ${given.length ? given.join(', ') : 'none'}).`)
  }

  if (isGiven(input.url)) {
    const url = String(input.url)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) throw new Error(`Fetching ${url} failed: ${response.status} ${response.statusText}`)
      return { text: await response.text() }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Fetching ${url} timed out after ${FETCH_TIMEOUT_MS}ms.`)
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  if (isGiven(input.filePath)) {
    const path = ctx.workspaceGuard.assertWithinWorkspace(String(input.filePath))
    const buf = await readFile(path)
    if (buf.byteLength > MAX_SOURCE_BYTES) {
      throw new Error(`File is ${buf.byteLength} bytes, over the ${MAX_SOURCE_BYTES}-byte limit.`)
    }
    return { text: buf.toString('utf-8'), writeBackPath: path }
  }

  return { text: String(input.text) }
}
