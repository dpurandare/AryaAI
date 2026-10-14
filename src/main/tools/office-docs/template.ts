import Docxtemplater from 'docxtemplater'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import PizZip from 'pizzip'
import type { Tool } from '../types'
import { extractOfficeText } from './extract'
import { resolveNewFilePath, workspaceRelativePath } from '../workspace-layout'

const MAX_TEMPLATE_BYTES = 20_000_000
const PLACEHOLDER_PATTERN = /\{[^}]+\}/g

function extensionOf(path: string): string {
  return extname(path).slice(1).toLowerCase()
}

function findPlaceholders(text: string): string[] {
  const matches = text.match(PLACEHOLDER_PATTERN) ?? []
  return [...new Set(matches)]
}

function describeRenderError(err: unknown): string {
  const properties = (err as { properties?: { errors?: Array<{ properties?: { explanation?: string } }> } })
    ?.properties
  const explanations = properties?.errors?.map((e) => e.properties?.explanation).filter(Boolean)
  if (explanations?.length) return explanations.join('; ')
  return err instanceof Error ? err.message : String(err)
}

export const officeFillTemplateTool: Tool = {
  name: 'office_fill_template',
  description:
    'Fill a user-authored .docx/.pptx template (from the workspace templates/ folder) containing ' +
    '{placeholder}/{#loop}...{/loop} markers, producing a new file with the original styling/branding ' +
    "intact — the one supported way to get template-driven output, distinct from office_create_document's " +
    "from-scratch build. action \"inspect\" (no data needed) lists the template's placeholders so you know " +
    'what data to supply; action "fill" (default) substitutes data into templatePath and writes outputPath ' +
    '— a brand-new output file is placed under documents/ automatically regardless of the path given, ' +
    'unless a file already exists there (then it writes back to that existing location instead); the ' +
    'result names the real path used.',
  inputSchema: {
    type: 'object',
    properties: {
      templatePath: { type: 'string', description: 'Path to the template, relative to the workspace root' },
      outputPath: { type: 'string', description: 'Where to write the filled document, relative to the workspace root' },
      action: { type: 'string', enum: ['inspect', 'fill'] },
      data: { type: 'object', description: 'fill only: values for each {placeholder}; array values for {#loop} sections' }
    },
    required: ['templatePath']
  },
  mutates: (input) => input.action !== 'inspect',
  describe(input) {
    if (input.action === 'inspect') return `Inspect placeholders in "${String(input.templatePath ?? '')}"`
    return `Fill "${String(input.templatePath ?? '')}" → "${String(input.outputPath ?? '')}"`
  },
  async execute(input, ctx) {
    const templateRelPath = String(input.templatePath ?? '')
    const extension = extensionOf(templateRelPath)
    if (extension !== 'docx' && extension !== 'pptx') {
      throw new Error(`office_fill_template only supports .docx and .pptx templates (got "${templateRelPath}").`)
    }
    const templateAbsPath = ctx.workspaceGuard.assertWithinWorkspace(templateRelPath)
    const templateBuffer = await readFile(templateAbsPath)
    if (templateBuffer.byteLength > MAX_TEMPLATE_BYTES) {
      throw new Error(`Template is ${templateBuffer.byteLength} bytes, over the ${MAX_TEMPLATE_BYTES}-byte limit.`)
    }

    const action = String(input.action ?? 'fill')
    if (action === 'inspect') {
      const text = await extractOfficeText(templateBuffer, extension)
      const placeholders = findPlaceholders(text)
      return placeholders.length
        ? `Placeholders found: ${placeholders.join(', ')}`
        : '(no {placeholder} markers found in this template)'
    }

    const outputRelPath = String(input.outputPath ?? '')
    if (!outputRelPath) throw new Error('outputPath is required for action "fill".')
    const outputAbsPath = resolveNewFilePath(ctx.workspaceGuard, outputRelPath)
    const data = typeof input.data === 'object' && input.data !== null ? (input.data as Record<string, unknown>) : {}

    let doc: Docxtemplater
    try {
      const zip = new PizZip(templateBuffer)
      doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, errorLogging: false })
      doc.render(data)
    } catch (err) {
      throw new Error(`Template render failed: ${describeRenderError(err)}`)
    }
    const outputBuffer = doc.getZip().generate({ type: 'nodebuffer' })
    await mkdir(dirname(outputAbsPath), { recursive: true })
    await writeFile(outputAbsPath, outputBuffer)
    return `Filled template written to ${workspaceRelativePath(ctx.workspaceGuard.root, outputAbsPath)}.`
  }
}
