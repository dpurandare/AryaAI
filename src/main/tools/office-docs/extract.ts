import JSZip from 'jszip'
import mammoth from 'mammoth'
import PizZip from 'pizzip'
import { XMLParser } from 'fast-xml-parser'

/**
 * Shared by office_read_document and office_fill_template's `inspect` action
 * (both need the same plain-text view of a docx/pptx — one to show the
 * agent the document's content, the other to regex-scan it for `{tag}`
 * placeholders left as literal text runs by whoever authored the template).
 */
export async function extractOfficeText(buffer: Buffer, extension: string): Promise<string> {
  if (extension === 'docx') return extractDocxText(buffer)
  if (extension === 'pptx') return extractPptxText(buffer)
  throw new Error(`Unsupported extension "${extension}" — expected docx or pptx.`)
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer })
  return value.trim()
}

const SLIDE_PATH = /^ppt\/slides\/slide(\d+)\.xml$/
const xmlParser = new XMLParser({ ignoreAttributes: true })

/**
 * pptxgenjs/docx can only generate a file from scratch, never open one —
 * confirmed via their real APIs, not assumed (see TASKS.md #73). Reading an
 * existing .pptx means unzipping it directly and pulling `<a:t>` text runs
 * out of each slide's own XML, in slide order.
 */
async function extractPptxText(buffer: Buffer): Promise<string> {
  const slides = await extractPptxRuns(buffer)
  return slides.map((runs, i) => `Slide ${i + 1}:\n${runs.join(' ').trim() || '(no text)'}`).join('\n\n')
}

/** Recursively pulls every value under a given tag key (`w:t` for docx, `a:t` for pptx) out of a parsed XML tree. */
function collectTagText(node: unknown, tag: string, out: string[]): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectTagText(item, tag, out)
    return
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === tag) {
      if (Array.isArray(value)) out.push(...value.map(String))
      else if (value !== undefined) out.push(String(value))
    } else {
      collectTagText(value, tag, out)
    }
  }
}

/**
 * Every real `<w:t>` (wordprocessingml text run) value in `word/document.xml`,
 * in document order — the raw, per-run granularity `office_extract_template`
 * (TASKS.md #84) needs to detect placeholder-looking content and later
 * substring-replace it, which mammoth's plain-text view can't provide (it
 * flattens formatting/run boundaries away entirely).
 */
export async function extractDocxRuns(buffer: Buffer): Promise<string[]> {
  const zip = new PizZip(buffer)
  const file = zip.file('word/document.xml')
  if (!file) return []
  const xml = file.asText()
  const runs: string[] = []
  collectTagText(xmlParser.parse(xml), 'w:t', runs)
  return runs
}

/** Same idea as extractDocxRuns, per slide (each slide's own `<a:t>` runs, in slide order) — pptx has no single document-wide XML part the way docx does. */
export async function extractPptxRuns(buffer: Buffer): Promise<string[][]> {
  const zip = await JSZip.loadAsync(buffer)
  const slideEntries = Object.keys(zip.files)
    .map((name) => ({ name, match: name.match(SLIDE_PATH) }))
    .filter((e): e is { name: string; match: RegExpMatchArray } => e.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))

  const slides: string[][] = []
  for (const { name } of slideEntries) {
    const xml = await zip.files[name].async('string')
    const runs: string[] = []
    collectTagText(xmlParser.parse(xml), 'a:t', runs)
    slides.push(runs)
  }
  return slides
}
