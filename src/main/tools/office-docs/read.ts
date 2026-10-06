import { resolveReadable } from '../../security/external-access'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Tool } from '../types'
import { extractOfficeText } from './extract'

const MAX_READ_BYTES = 20_000_000

function extensionOf(path: string): string {
  return extname(path).slice(1).toLowerCase()
}

export const officeReadDocumentTool: Tool = {
  name: 'office_read_document',
  description:
    'Read the text content of an existing .docx or .pptx file in the workspace. In-place editing of ' +
    "these formats isn't supported (see office_create_document) — this is read-only, for reading a " +
    'document to work from, or scanning a template for its {tag} placeholders before office_fill_template.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path relative to the workspace root, .docx or .pptx' } },
    required: ['path']
  },
  mutates: false,
  externalPaths: (input) => [{ path: String(input.path ?? ''), access: 'read' }],
  async execute(input, ctx) {
    const relPath = String(input.path ?? '')
    const extension = extensionOf(relPath)
    if (extension !== 'docx' && extension !== 'pptx') {
      throw new Error(`office_read_document only supports .docx and .pptx (got "${relPath}").`)
    }
    const absPath = resolveReadable(ctx, relPath)
    const buffer = await readFile(absPath)
    if (buffer.byteLength > MAX_READ_BYTES) {
      throw new Error(`File is ${buffer.byteLength} bytes, over the ${MAX_READ_BYTES}-byte read limit.`)
    }
    const text = await extractOfficeText(buffer, extension)
    return text || '(document has no extractable text)'
  }
}
