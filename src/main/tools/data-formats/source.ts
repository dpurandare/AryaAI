import { readFile } from 'node:fs/promises'
import { isInsideWorkspace, resolveReadable } from '../../security/external-access'
import type { ExternalPathRequest, ToolContext } from '../types'

const FETCH_TIMEOUT_MS = 30_000
/** Identifies the app honestly while staying browser-compatible: Node's default user agent is refused outright (connection reset) by sites such as Wikimedia, which made every page there unreadable. Shared with download_image. */
export const FETCH_USER_AGENT = 'Mozilla/5.0 (compatible; Sachivji/0.2; +https://github.com/dpurandare/AryaAI)'
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

/** The outside-the-workspace path a parse_* call would read, for `Tool.externalPaths`. */
export function sourceExternalPaths(input: SourceInput): ExternalPathRequest[] {
  return isGiven(input.filePath) ? [{ path: String(input.filePath), access: 'read' }] : []
}

/**
 * A PDF, picture, archive or office file is not a web page or a data table. Found live: a large PDF fed to the HTML parser
 * blocked the whole app for about 100 seconds and ended in "Maximum call stack size exceeded" — the window froze and
 * had to be restarted. Refuse by Content-Type before reading a byte, with a message the model can act on.
 */
const BINARY_CONTENT_TYPE = /^(application\/pdf|image\/|video\/|audio\/|application\/(zip|gzip|x-[\w.-]+|msword|vnd\.ms-[\w.-]+|vnd\.openxmlformats[\w.+-]*))/i

function refuseBinary(url: string, contentType: string | null): void {
  const type = (contentType ?? '').split(';')[0].trim()
  if (!type || !BINARY_CONTENT_TYPE.test(type)) return
  throw new Error(
    `${url} is ${type === 'application/pdf' ? 'a PDF' : `a ${type} file`}, not a web page or text data, and cannot be read here — it would stall the app. ` +
      'Use an HTML version of the page, or another source.'
  )
}

/** Reads a response body as text, giving up the moment it passes MAX_SOURCE_BYTES (and refusing a PDF whatever its Content-Type claimed). */
async function readTextCapped(response: Response, url: string): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return response.text()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (chunks.length === 0 && value.byteLength >= 5 && String.fromCharCode(value[0], value[1], value[2], value[3], value[4]) === '%PDF-') {
      await reader.cancel()
      throw new Error(`${url} is a PDF, not a web page or text data, and cannot be read here — it would stall the app. Use an HTML version of the page, or another source.`)
    }
    if (total > MAX_SOURCE_BYTES) {
      await reader.cancel()
      throw new Error(`${url} is larger than the ${MAX_SOURCE_BYTES}-byte limit for a page or data file.`)
    }
    chunks.push(value)
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks))
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
      const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': FETCH_USER_AGENT } })
      if (!response.ok) throw new Error(`Fetching ${url} failed: ${response.status} ${response.statusText}`)
      refuseBinary(url, response.headers.get('content-type'))
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > MAX_SOURCE_BYTES) throw new Error(`${url} is ${declared} bytes, over the ${MAX_SOURCE_BYTES}-byte limit for a page or data file.`)
      return { text: await readTextCapped(response, url) }
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
    const path = resolveReadable(ctx, String(input.filePath))
    const buf = await readFile(path)
    if (buf.byteLength > MAX_SOURCE_BYTES) {
      throw new Error(`File is ${buf.byteLength} bytes, over the ${MAX_SOURCE_BYTES}-byte limit.`)
    }
    // A file outside the workspace is read-only: appending to it would edit it.
    return { text: buf.toString('utf-8'), writeBackPath: isInsideWorkspace(ctx, String(input.filePath)) ? path : undefined }
  }

  return { text: String(input.text) }
}
