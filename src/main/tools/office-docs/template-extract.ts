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

/**
 * What an `apply` left untouched. A template is meant to hold no one's own data, so
 * the paragraphs that still have no {placeholder} are listed (longest first) for the
 * model and the user to confirm as fixed wording or turn into placeholders.
 */
function leftoverReport(texts: string[]): string {
  const total = texts.length
  const plain = texts.filter((t) => !/\{[#/^]?[A-Za-z_][A-Za-z0-9_]*\}/.test(t))
  if (total === 0) return ''
  const sample = [...plain]
    .sort((a, b) => b.length - a.length)
    .slice(0, 5)
    .map((t) => `\n  - "${t.length > 80 ? `${t.slice(0, 80)}…` : t}"`)
    .join('')
  const mostly = plain.length / total > 0.5
  return (
    `\n\nStill the original text: ${plain.length} of ${total} paragraphs/cells have no placeholder${plain.length ? '. Longest:' + sample : '.'}` +
    (plain.length
      ? `\nA template should hold none of the source's own content. ${mostly ? 'Most of this document is still the original — ' : ''}` +
        'Tell the user which of these you kept as fixed wording (headings, labels, standard text) and which you propose to make placeholders, ' +
        'and apply again with the additions if they want them replaced.'
      : '')
  )
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function encodeXmlEntities(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Substitutes one replacement's `text` with `{placeholder}` in every paragraph
 * (`paraRegex`) of `xmlStr`, matching against the paragraph's text as a whole
 * so a name or phrase that Word split over several runs (`<w:t>` for docx,
 * `<a:t>` for pptx) is still found. The placeholder goes into the run the
 * match starts in, and the rest of the matched characters are removed from
 * the runs they were in, so each run keeps its own formatting and nothing
 * outside run text is touched. `counterRef` is shared across every XML part
 * this replacement is applied to (docx has one; pptx has one per slide, applied
 * in slide order) so `occurrence` counts matches in real document order.
 */
function replaceInParagraphs(
  xmlStr: string,
  paraRegex: RegExp,
  runRegex: RegExp,
  targetText: string,
  placeholder: string,
  occurrence: number | undefined,
  counterRef: { count: number }
): { result: string; matchedCount: number } {
  let matchedCount = 0
  const result = xmlStr.replace(paraRegex, (paragraph: string) => {
    const runs: { start: number; end: number; text: string }[] = []
    for (const m of paragraph.matchAll(runRegex)) {
      const start = (m.index ?? 0) + m[1].length
      runs.push({ start, end: start + m[2].length, text: decodeXmlEntities(m[2]) })
    }
    if (runs.length === 0) return paragraph
    const full = runs.map((r) => r.text).join('')
    // Non-overlapping matches, in order, each flagged selected or skipped by `occurrence`.
    const selected: number[] = []
    for (let at = full.indexOf(targetText); at !== -1; at = full.indexOf(targetText, at + targetText.length)) {
      if (occurrence !== undefined) {
        counterRef.count++
        if (counterRef.count !== occurrence) continue
      }
      selected.push(at)
    }
    if (selected.length === 0) return paragraph
    matchedCount += selected.length

    const consumed = new Array<boolean>(full.length).fill(false)
    for (const at of selected) consumed.fill(true, at, at + targetText.length)
    const starts = new Set(selected)
    const out = runs.map(() => '')
    let pos = 0
    runs.forEach((r, i) => {
      for (const ch of r.text) {
        if (starts.has(pos)) out[i] += `{${placeholder}}`
        else if (!consumed[pos]) out[i] += ch
        pos += ch.length
      }
    })

    let rebuilt = ''
    let last = 0
    runs.forEach((r, i) => {
      rebuilt += paragraph.slice(last, r.start) + encodeXmlEntities(out[i])
      last = r.end
    })
    return rebuilt + paragraph.slice(last)
  })
  return { result, matchedCount }
}

/** Visible text of each paragraph (runs joined), empty paragraphs dropped. */
function paragraphTexts(xmlStr: string, paraRegex: RegExp, runRegex: RegExp): string[] {
  const texts: string[] = []
  for (const paragraph of xmlStr.match(paraRegex) ?? []) {
    const text = [...paragraph.matchAll(runRegex)].map((m) => decodeXmlEntities(m[2])).join('')
    if (text.trim()) texts.push(text.trim())
  }
  return texts
}

const DOCX_PARAGRAPH = /<w:p[ >][\s\S]*?<\/w:p>/g
const DOCX_RUN = /(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g
const PPTX_PARAGRAPH = /<a:p[ >][\s\S]*?<\/a:p>/g
const PPTX_RUN = /(<a:t(?:\s[^>]*)?>)([^<]*)(<\/a:t>)/g

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

interface Applied {
  counts: number[]
  /** Text of every non-empty paragraph / cell after the replacements, for the leftover report. */
  texts: string[]
}

async function applyToDocx(buffer: Buffer, replacements: Replacement[]): Promise<Applied & { buffer: Buffer }> {
  const zip = new PizZip(buffer)
  const file = zip.file('word/document.xml')
  if (!file) throw new Error('This .docx has no word/document.xml part — it may be corrupt.')
  let xml = file.asText()
  const counts: number[] = []
  for (const r of replacements) {
    const { result, matchedCount } = replaceInParagraphs(xml, DOCX_PARAGRAPH, DOCX_RUN, r.text, r.placeholder, r.occurrence, { count: 0 })
    xml = result
    counts.push(matchedCount)
  }
  zip.file('word/document.xml', xml)
  return { buffer: zip.generate({ type: 'nodebuffer' }), counts, texts: paragraphTexts(xml, DOCX_PARAGRAPH, DOCX_RUN) }
}

const SLIDE_PATH = /^ppt\/slides\/slide(\d+)\.xml$/

async function applyToPptx(buffer: Buffer, replacements: Replacement[]): Promise<Applied & { buffer: Buffer }> {
  const zip = await JSZip.loadAsync(buffer)
  const slideEntries = Object.keys(zip.files)
    .map((name) => ({ name, match: name.match(SLIDE_PATH) }))
    .filter((e): e is { name: string; match: RegExpMatchArray } => e.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))

  const counts: number[] = []
  for (const r of replacements) {
    const counterRef = { count: 0 }
    let matchedCount = 0
    for (const { name } of slideEntries) {
      const xml = await zip.files[name].async('string')
      const result = replaceInParagraphs(xml, PPTX_PARAGRAPH, PPTX_RUN, r.text, r.placeholder, r.occurrence, counterRef)
      matchedCount += result.matchedCount
      zip.file(name, result.result)
    }
    counts.push(matchedCount)
  }
  const texts: string[] = []
  for (const { name } of slideEntries) {
    texts.push(...paragraphTexts(await zip.files[name].async('string'), PPTX_PARAGRAPH, PPTX_RUN))
  }
  return { buffer: await zip.generateAsync({ type: 'nodebuffer' }), counts, texts }
}

async function applyToXlsx(buffer: Buffer, replacements: Replacement[]): Promise<Applied & { workbook: ExcelJS.Workbook }> {
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
  const texts: string[] = []
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = cellValueToText(cell.value).trim()
        if (text) texts.push(text)
      })
    })
  }
  return { workbook, counts, texts }
}

export const officeExtractTemplateTool: Tool = {
  name: 'office_extract_template',
  description:
    'Turn an existing .docx/.pptx/.xlsx into a reusable template under templates/, for office_fill_template. ' +
    'A template holds NONE of the source\'s own content: every name, employer, date, number and piece of free text ' +
    '(summary, descriptions, bullets) specific to this document becomes a {placeholder}; only headings, labels and standard ' +
    'wording stay. action "detect" (default, read-only) lists dates, amounts, emails, phones, URLs — a first pass; read the ' +
    'document section by section and propose the rest, and show the user the FULL list (and what stays fixed) before applying. ' +
    'action "apply" (mutates) takes the confirmed exact-text → placeholder replacements (text may span formatting runs, not ' +
    'paragraphs) and writes templates/<templateName>, keeping the formatting; the result lists paragraphs still holding original ' +
    'text. Iterative: each apply starts fresh from the source.',
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
    let texts: string[]
    await mkdir(join(ctx.workspaceGuard.root, 'templates'), { recursive: true })
    if (extension === 'docx') {
      const result = await applyToDocx(buffer, replacements)
      counts = result.counts
      texts = result.texts
      await writeFile(outputAbsPath, result.buffer)
    } else if (extension === 'pptx') {
      const result = await applyToPptx(buffer, replacements)
      counts = result.counts
      texts = result.texts
      await writeFile(outputAbsPath, result.buffer)
    } else {
      const result = await applyToXlsx(buffer, replacements)
      counts = result.counts
      texts = result.texts
      await result.workbook.xlsx.writeFile(outputAbsPath)
    }

    const summary = replacements
      .map((r, i) => `"${r.text}" → {${r.placeholder}}: ${counts[i]} replacement(s)`)
      .join('\n')
    const unmatched = replacements.filter((_, i) => counts[i] === 0)
    const warning = unmatched.length
      ? `\n\nWarning: ${unmatched.length} replacement(s) matched nothing (text not found verbatim in one paragraph/cell — check for typos or line breaks; text across paragraphs needs one replacement per paragraph): ${unmatched.map((r) => `"${r.text}"`).join(', ')}`
      : ''
    return `Template written to ${workspaceRelativePath(ctx.workspaceGuard.root, outputAbsPath)}.\n${summary}${warning}${leftoverReport(texts)}`
  }
}
