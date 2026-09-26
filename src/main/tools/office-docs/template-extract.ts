import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import PizZip from 'pizzip'
import type { Tool } from '../types'
import { workspaceRelativePath } from '../workspace-layout'
import { extractDocxRuns, extractPptxRuns } from './extract'
import { detectPlaceholderCandidates, type PlaceholderCandidate } from './placeholder-detect'

const MAX_SOURCE_BYTES = 20_000_000
const PLACEHOLDER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

interface Replacement {
  text: string
  placeholder: string
  occurrence?: number
}

function extensionOf(path: string): string {
  return extname(path).slice(1).toLowerCase()
}

function cellValueToText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && 'text' in value) return String((value as { text: unknown }).text)
  if (typeof value === 'object' && 'result' in value) return String((value as { result: unknown }).result)
  return String(value)
}

function formatCandidates(candidates: PlaceholderCandidate[]): string {
  if (candidates.length === 0) {
    return (
      '(no automatic candidates found — this mechanical pass only looks for dates/amounts/emails/' +
      'phone numbers/percentages/URLs; the document may still have name/address/free-text fields worth ' +
      'templatizing, which need your own judgment, not a regex)'
    )
  }
  const lines = candidates.map(
    (c, i) => `${i + 1}. [${c.category}] "${c.text}" → suggested {${c.suggestedName}} (${c.occurrences} occurrence(s))`
  )
  return (
    `Detected ${candidates.length} placeholder candidate(s):\n${lines.join('\n')}\n\n` +
    'This is a mechanical first pass only — it does NOT detect names, addresses, or other free-text ' +
    'fields; read the document yourself (office_read_document) and propose those to the user directly ' +
    'if relevant. Discuss the full candidate list (including any you add) with the user before calling ' +
    'this tool again with action "apply" — they may want to exclude some, rename others, or add fields ' +
    'this pass missed. This can be iterative: apply, show the user the result (office_read_document/' +
    'xlsx_read on the new template), and call apply again with a refined replacement list until they' +
    " confirm it's right — each apply call regenerates fresh from the original source, so nothing is lost" +
    ' by iterating.'
  )
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function encodeXmlEntities(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Substitutes one replacement's `text` with `{placeholder}` inside every
 * `<tag ...>...</tag>` text-run element found in `xmlStr` (`<w:t>` for docx,
 * `<a:t>` for pptx) — never touching anything outside a run's own text
 * content, so surrounding formatting/structure is untouched. `counterRef` is
 * shared across every XML part this replacement is applied to (docx has
 * one; pptx has one per slide, applied in slide order) so `occurrence`
 * counts in real document order, not per-part. Occurrence counting is at
 * run granularity — if the *same* literal text appears twice within one
 * single run's content (rare in practice: runs are usually short label/
 * value fragments), both count as one occurrence together, a deliberate,
 * documented simplification rather than a full per-substring N-th-match
 * engine.
 */
function replaceInXmlPart(
  xmlStr: string,
  tagRegex: RegExp,
  targetText: string,
  placeholder: string,
  occurrence: number | undefined,
  counterRef: { count: number }
): { result: string; matchedCount: number } {
  let matchedCount = 0
  const result = xmlStr.replace(tagRegex, (match, open: string, content: string, close: string) => {
    const decoded = decodeXmlEntities(content)
    if (!decoded.includes(targetText)) return match
    if (occurrence !== undefined) {
      counterRef.count++
      if (counterRef.count !== occurrence) return match
    }
    matchedCount++
    const replaced = decoded.split(targetText).join(`{${placeholder}}`)
    return `${open}${encodeXmlEntities(replaced)}${close}`
  })
  return { result, matchedCount }
}

/** See the comment at applyToXlsx's own call to this — isolates the one-off Buffer-generic type mismatch to a single place instead of scattering `as unknown as ...` casts across every load() call site. */
async function loadExcelBuffer(workbook: ExcelJS.Workbook, buffer: Buffer): Promise<void> {
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0])
}

function validateReplacements(replacements: unknown): Replacement[] {
  if (!Array.isArray(replacements) || replacements.length === 0) {
    throw new Error('"replacements" is required for action "apply" — call action "detect" first to find candidates.')
  }
  return replacements.map((r, i) => {
    const text = typeof r === 'object' && r !== null ? String((r as Replacement).text ?? '') : ''
    const placeholder = typeof r === 'object' && r !== null ? String((r as Replacement).placeholder ?? '') : ''
    const occurrence = typeof r === 'object' && r !== null ? (r as Replacement).occurrence : undefined
    if (!text) throw new Error(`replacements[${i}].text is required.`)
    if (!PLACEHOLDER_NAME_PATTERN.test(placeholder)) {
      throw new Error(
        `replacements[${i}].placeholder "${placeholder}" is invalid — use letters/digits/underscore only, starting with a letter or underscore (e.g. "invoiceDate").`
      )
    }
    return { text, placeholder, occurrence: typeof occurrence === 'number' ? occurrence : undefined }
  })
}

async function applyToDocx(buffer: Buffer, replacements: Replacement[]): Promise<{ buffer: Buffer; counts: number[] }> {
  const zip = new PizZip(buffer)
  const file = zip.file('word/document.xml')
  if (!file) throw new Error('This .docx has no word/document.xml part — it may be corrupt.')
  let xml = file.asText()
  const tagRegex = /(<w:t[^>]*>)([^<]*)(<\/w:t>)/g
  const counts: number[] = []
  for (const r of replacements) {
    const { result, matchedCount } = replaceInXmlPart(xml, tagRegex, r.text, r.placeholder, r.occurrence, { count: 0 })
    xml = result
    counts.push(matchedCount)
  }
  zip.file('word/document.xml', xml)
  return { buffer: zip.generate({ type: 'nodebuffer' }), counts }
}

const SLIDE_PATH = /^ppt\/slides\/slide(\d+)\.xml$/

async function applyToPptx(buffer: Buffer, replacements: Replacement[]): Promise<{ buffer: Buffer; counts: number[] }> {
  const zip = await JSZip.loadAsync(buffer)
  const slideEntries = Object.keys(zip.files)
    .map((name) => ({ name, match: name.match(SLIDE_PATH) }))
    .filter((e): e is { name: string; match: RegExpMatchArray } => e.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))

  const tagRegex = /(<a:t>)([^<]*)(<\/a:t>)/g
  const counts: number[] = []
  for (const r of replacements) {
    const counterRef = { count: 0 }
    let matchedCount = 0
    for (const { name } of slideEntries) {
      const xml = await zip.files[name].async('string')
      const result = replaceInXmlPart(xml, tagRegex, r.text, r.placeholder, r.occurrence, counterRef)
      matchedCount += result.matchedCount
      zip.file(name, result.result)
    }
    counts.push(matchedCount)
  }
  return { buffer: await zip.generateAsync({ type: 'nodebuffer' }), counts }
}

async function applyToXlsx(buffer: Buffer, replacements: Replacement[]): Promise<{ workbook: ExcelJS.Workbook; counts: number[] }> {
  const workbook = new ExcelJS.Workbook()
  // exceljs's own .d.ts (built against an older @types/node) expects the
  // non-generic ambient `Buffer`, while node:fs/promises's readFile() now
  // returns the newer generic `Buffer<ArrayBufferLike>` — structurally the
  // same bytes at runtime, but two distinct type identities under the
  // current @types/node; loadExcelBuffer below sidesteps the mismatch.
  await loadExcelBuffer(workbook, buffer)
  const counts: number[] = []
  for (const r of replacements) {
    let matchedCount = 0
    for (const worksheet of workbook.worksheets) {
      worksheet.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          const current = cellValueToText(cell.value)
          if (current.includes(r.text)) {
            cell.value = current.split(r.text).join(`{${r.placeholder}}`)
            matchedCount++
          }
        })
      })
    }
    counts.push(matchedCount)
  }
  return { workbook, counts }
}

export const officeExtractTemplateTool: Tool = {
  name: 'office_extract_template',
  description:
    'Turn an existing .docx/.pptx/.xlsx document into a reusable template under templates/, for office_fill_template. ' +
    'action "detect" (default, read-only) lists variable-looking content (dates, amounts, percentages, emails, phone ' +
    'numbers, URLs) with a suggested {placeholder} name — a mechanical first pass: also propose names, addresses and ' +
    'other free text yourself, and confirm the FULL list with the user before applying (which fields are truly variable ' +
    'is their call). action "apply" (mutates) takes the confirmed exact-text → placeholder replacements and writes ' +
    'templates/<templateName>, keeping the original formatting exactly. It is iterative: apply, show the user, refine ' +
    'the list, apply again — each call starts fresh from the original document. Only text inside a single text run can ' +
    'be matched; a phrase split across runs by editing history may not be found.',
  inputSchema: {
    type: 'object',
    properties: {
      sourcePath: { type: 'string', description: 'Existing .docx/.pptx/.xlsx document, relative to the workspace root' },
      action: { type: 'string', enum: ['detect', 'apply'] },
      templateName: {
        type: 'string',
        description:
          'apply only: filename under templates/ (same extension as sourcePath); any directory part is ignored.'
      },
      replacements: {
        type: 'array',
        description: 'apply only: exact text → placeholder mappings, confirmed with the user first',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Exact text to replace, as it appears in the document' },
            placeholder: { type: 'string', description: 'Placeholder name, e.g. "invoiceDate" (becomes {invoiceDate})' },
            occurrence: {
              type: 'number',
              description: 'Optional: replace only this 1-based occurrence (in document order) instead of every occurrence of this text'
            }
          },
          required: ['text', 'placeholder']
        }
      }
    },
    required: ['sourcePath']
  },
  mutates: (input) => input.action === 'apply',
  describe(input) {
    const replacements = Array.isArray(input.replacements) ? input.replacements.length : 0
    return `Extract template from "${String(input.sourcePath ?? '')}" → templates/${basename(String(input.templateName ?? ''))} (${replacements} replacement(s))`
  },
  async execute(input, ctx) {
    const sourceRelPath = String(input.sourcePath ?? '')
    const extension = extensionOf(sourceRelPath)
    if (extension !== 'docx' && extension !== 'pptx' && extension !== 'xlsx') {
      throw new Error(`office_extract_template only supports .docx, .pptx, and .xlsx (got "${sourceRelPath}").`)
    }
    const sourceAbsPath = ctx.workspaceGuard.assertWithinWorkspace(sourceRelPath)
    const buffer = await readFile(sourceAbsPath)
    if (buffer.byteLength > MAX_SOURCE_BYTES) {
      throw new Error(`Source is ${buffer.byteLength} bytes, over the ${MAX_SOURCE_BYTES}-byte limit.`)
    }

    const action = String(input.action ?? 'detect')
    if (action === 'detect') {
      let runs: string[]
      if (extension === 'docx') {
        runs = await extractDocxRuns(buffer)
      } else if (extension === 'pptx') {
        runs = (await extractPptxRuns(buffer)).flat()
      } else {
        const workbook = new ExcelJS.Workbook()
        await loadExcelBuffer(workbook, buffer)
        runs = []
        for (const worksheet of workbook.worksheets) {
          worksheet.eachRow({ includeEmpty: false }, (row) => {
            row.eachCell({ includeEmpty: false }, (cell) => {
              const text = cellValueToText(cell.value)
              if (text) runs.push(text)
            })
          })
        }
      }
      return formatCandidates(detectPlaceholderCandidates(runs))
    }

    if (action !== 'apply') {
      throw new Error(`Unknown action "${action}" — must be "detect" or "apply".`)
    }

    const templateNameInput = String(input.templateName ?? '')
    if (!templateNameInput.trim()) throw new Error('"templateName" is required for action "apply".')
    const templateName = basename(templateNameInput)
    if (extensionOf(templateName) !== extension) {
      throw new Error(`templateName must have the same ".${extension}" extension as sourcePath.`)
    }
    const replacements = validateReplacements(input.replacements)
    const outputAbsPath = ctx.workspaceGuard.assertWithinWorkspace(join('templates', templateName))

    let counts: number[]
    await mkdir(join(ctx.workspaceGuard.root, 'templates'), { recursive: true })
    if (extension === 'docx') {
      const result = await applyToDocx(buffer, replacements)
      counts = result.counts
      await writeFile(outputAbsPath, result.buffer)
    } else if (extension === 'pptx') {
      const result = await applyToPptx(buffer, replacements)
      counts = result.counts
      await writeFile(outputAbsPath, result.buffer)
    } else {
      const result = await applyToXlsx(buffer, replacements)
      counts = result.counts
      await result.workbook.xlsx.writeFile(outputAbsPath)
    }

    const summary = replacements
      .map((r, i) => `"${r.text}" → {${r.placeholder}}: ${counts[i]} replacement(s)`)
      .join('\n')
    const unmatched = replacements.filter((_, i) => counts[i] === 0)
    const warning = unmatched.length
      ? `\n\nWarning: ${unmatched.length} replacement(s) matched nothing (text not found verbatim in a single run/cell — check for typos or a phrase split across multiple runs): ${unmatched.map((r) => `"${r.text}"`).join(', ')}`
      : ''
    return `Template written to ${workspaceRelativePath(ctx.workspaceGuard.root, outputAbsPath)}.\n${summary}${warning}`
  }
}
