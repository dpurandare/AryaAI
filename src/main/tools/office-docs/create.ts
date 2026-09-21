import { Document, HeadingLevel, Packer, Paragraph } from 'docx'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import pptxgen from 'pptxgenjs'
import type { Tool } from '../types'

interface DocxSection {
  heading?: string
  paragraphs?: string[]
  bullets?: string[]
}

interface PptxSlide {
  title?: string
  bullets?: string[]
  notes?: string
}

function extensionOf(path: string): string {
  return extname(path).slice(1).toLowerCase()
}

async function buildDocx(title: string | undefined, sections: DocxSection[]): Promise<Buffer> {
  const children: Paragraph[] = []
  if (title) children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }))
  for (const section of sections) {
    if (section.heading) children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }))
    for (const paragraph of section.paragraphs ?? []) children.push(new Paragraph({ text: paragraph }))
    for (const bullet of section.bullets ?? []) children.push(new Paragraph({ text: bullet, bullet: { level: 0 } }))
  }
  const doc = new Document({ sections: [{ children }] })
  return Packer.toBuffer(doc)
}

async function buildPptx(absPath: string, title: string | undefined, slides: PptxSlide[]): Promise<void> {
  const pres = new pptxgen()
  if (title) {
    const titleSlide = pres.addSlide()
    titleSlide.addText(title, { x: 0.5, y: 2.5, w: '90%', h: 1, fontSize: 32, bold: true, align: 'center' })
  }
  for (const slide of slides) {
    const s = pres.addSlide()
    if (slide.title) s.addText(slide.title, { x: 0.5, y: 0.3, w: '90%', h: 0.75, fontSize: 24, bold: true })
    if (slide.bullets?.length) {
      s.addText(
        slide.bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
        { x: 0.5, y: 1.2, w: '90%', h: 4, fontSize: 16 }
      )
    }
    if (slide.notes) s.addNotes(slide.notes)
  }
  await pres.writeFile({ fileName: absPath })
}

export const officeCreateDocumentTool: Tool = {
  name: 'office_create_document',
  description:
    'Create a new .docx or .pptx file from scratch inside the workspace — the format is chosen by the ' +
    "path's extension. This can only build a new document, never open/edit an existing one (docx/pptxgenjs " +
    "have no load capability for these formats — see office_fill_template for the one supported way back " +
    "into 'editing', via a user-authored template). For .docx, provide sections (each an optional heading " +
    'plus paragraphs/bullets). For .pptx, provide slides (each an optional title, bullets, and speaker notes).',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Output path relative to the workspace root, .docx or .pptx' },
      title: { type: 'string', description: 'Optional document title / opening title slide' },
      sections: {
        type: 'array',
        description: 'docx only',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            paragraphs: { type: 'array', items: { type: 'string' } },
            bullets: { type: 'array', items: { type: 'string' } }
          }
        }
      },
      slides: {
        type: 'array',
        description: 'pptx only',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            bullets: { type: 'array', items: { type: 'string' } },
            notes: { type: 'string' }
          }
        }
      }
    },
    required: ['path']
  },
  mutates: true,
  describe(input) {
    return `Create "${String(input.path ?? '')}"`
  },
  async execute(input, ctx) {
    const relPath = String(input.path ?? '')
    const extension = extensionOf(relPath)
    if (extension !== 'docx' && extension !== 'pptx') {
      throw new Error(`office_create_document only supports .docx and .pptx (got "${relPath}").`)
    }
    const absPath = ctx.workspaceGuard.assertWithinWorkspace(relPath)
    await mkdir(dirname(absPath), { recursive: true })
    const title = typeof input.title === 'string' ? input.title : undefined

    if (extension === 'docx') {
      const sections = Array.isArray(input.sections) ? (input.sections as DocxSection[]) : []
      const buffer = await buildDocx(title, sections)
      await writeFile(absPath, buffer)
    } else {
      const slides = Array.isArray(input.slides) ? (input.slides as PptxSlide[]) : []
      await buildPptx(absPath, title, slides)
    }
    return `Created ${relPath}.`
  }
}
