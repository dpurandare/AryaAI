import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import PizZip from 'pizzip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import type { ToolContext } from '../types'
import { officeCreateDocumentTool } from './create'
import { extractDocxRuns, extractPptxRuns } from './extract'
import { officeFillTemplateTool } from './template'
import { officeExtractTemplateTool } from './template-extract'
import { xlsxWriteTool } from './xlsx'

describe('office_extract_template', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-office-extract-template-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('mutates only for action "apply", not "detect"', () => {
    const mutates = officeExtractTemplateTool.mutates as (input: Record<string, unknown>) => boolean
    expect(mutates({})).toBe(false)
    expect(mutates({ action: 'detect' })).toBe(false)
    expect(mutates({ action: 'apply' })).toBe(true)
  })

  it('rejects an unsupported source extension', async () => {
    await expect(officeExtractTemplateTool.execute({ sourcePath: 'notes.txt' }, ctx)).rejects.toThrow(
      /only supports .docx, .pptx, and .xlsx/
    )
  })

  describe('action "detect"', () => {
    it('lists real placeholder candidates found in a .docx, formatted for the agent to relay', async () => {
      await officeCreateDocumentTool.execute(
        { path: 'invoice.docx', sections: [{ paragraphs: ['Invoice Date: 2026-09-24', 'Amount Due: $1,250.00'] }] },
        ctx
      )
      const result = await officeExtractTemplateTool.execute(
        { sourcePath: 'documents/invoice.docx', action: 'detect' },
        ctx
      )
      expect(result).toContain('Detected 2 placeholder candidate(s)')
      expect(result).toContain('[date] "2026-09-24"')
      expect(result).toContain('[currency] "$1,250.00"')
      expect(result).toContain('does NOT detect names, addresses')
    })

    it('lists candidates found across every slide of a .pptx', async () => {
      await officeCreateDocumentTool.execute(
        { path: 'deck.pptx', slides: [{ bullets: ['Contact: sales@acme.example.com'] }] },
        ctx
      )
      const result = await officeExtractTemplateTool.execute({ sourcePath: 'documents/deck.pptx', action: 'detect' }, ctx)
      expect(result).toContain('[email] "sales@acme.example.com"')
    })

    it('lists candidates found in .xlsx cell values', async () => {
      await xlsxWriteTool.execute(
        { path: 'orders.xlsx', sheet: 'Sheet1', rows: [['Customer', 'Total'], ['Acme', '$1,250.00']] },
        ctx
      )
      const result = await officeExtractTemplateTool.execute({ sourcePath: 'documents/orders.xlsx', action: 'detect' }, ctx)
      expect(result).toContain('[currency] "$1,250.00"')
    })

    it('says plainly when nothing was found, rather than an empty/blank result', async () => {
      await officeCreateDocumentTool.execute({ path: 'plain.docx', sections: [{ paragraphs: ['Thank you.'] }] }, ctx)
      const result = await officeExtractTemplateTool.execute({ sourcePath: 'documents/plain.docx', action: 'detect' }, ctx)
      expect(result).toContain('no automatic candidates found')
    })
  })

  describe('action "apply"', () => {
    it('writes a real templates/<name>.docx with matched text replaced by {placeholder}, preserving everything else', async () => {
      await officeCreateDocumentTool.execute(
        {
          path: 'invoice.docx',
          sections: [{ paragraphs: ['Invoice for Acme Corp', 'Amount Due: $1,250.00', 'Amount Due: $1,250.00 again'] }]
        },
        ctx
      )
      const result = await officeExtractTemplateTool.execute(
        {
          sourcePath: 'documents/invoice.docx',
          action: 'apply',
          templateName: 'invoice-template.docx',
          replacements: [
            { text: 'Acme Corp', placeholder: 'customerName' },
            { text: '$1,250.00', placeholder: 'amountDue' }
          ]
        },
        ctx
      )
      expect(result).toContain('Template written to templates/invoice-template.docx')
      expect(result).toContain('"Acme Corp" → {customerName}: 1 replacement(s)')
      expect(result).toContain('"$1,250.00" → {amountDue}: 2 replacement(s)')

      const info = await stat(join(root, 'templates', 'invoice-template.docx'))
      expect(info.size).toBeGreaterThan(0)

      const buffer = await readFile(join(root, 'templates', 'invoice-template.docx'))
      const runs = await extractDocxRuns(buffer)
      expect(runs).toContain('Invoice for {customerName}')
      expect(runs).toContain('Amount Due: {amountDue}')
      expect(runs).toContain('Amount Due: {amountDue} again')
    })

    it('writes a real templates/<name>.pptx, replacing matched text on every slide', async () => {
      await officeCreateDocumentTool.execute(
        { path: 'deck.pptx', slides: [{ bullets: ['Prepared for Acme Corp'] }, { bullets: ['Total: $1,250.00'] }] },
        ctx
      )
      await officeExtractTemplateTool.execute(
        {
          sourcePath: 'documents/deck.pptx',
          action: 'apply',
          templateName: 'deck-template.pptx',
          replacements: [
            { text: 'Acme Corp', placeholder: 'clientName' },
            { text: '$1,250.00', placeholder: 'total' }
          ]
        },
        ctx
      )
      const buffer = await readFile(join(root, 'templates', 'deck-template.pptx'))
      const slides = await extractPptxRuns(buffer)
      expect(slides.flat()).toContain('Prepared for {clientName}')
      expect(slides.flat()).toContain('Total: {total}')
    })

    it('writes a real templates/<name>.xlsx with matched cell values replaced', async () => {
      await xlsxWriteTool.execute(
        { path: 'orders.xlsx', sheet: 'Sheet1', rows: [['Customer', 'Total'], ['Acme Corp', '$1,250.00']] },
        ctx
      )
      await officeExtractTemplateTool.execute(
        {
          sourcePath: 'documents/orders.xlsx',
          action: 'apply',
          templateName: 'orders-template.xlsx',
          replacements: [
            { text: 'Acme Corp', placeholder: 'customerName' },
            { text: '$1,250.00', placeholder: 'total' }
          ]
        },
        ctx
      )
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.readFile(join(root, 'templates', 'orders-template.xlsx'))
      const sheet = workbook.getWorksheet('Sheet1')
      expect(sheet?.getCell('A2').value).toBe('{customerName}')
      expect(sheet?.getCell('B2').value).toBe('{total}')
    })

    it('always saves directly under templates/, ignoring any directory component in templateName', async () => {
      await officeCreateDocumentTool.execute({ path: 'a.docx', sections: [{ paragraphs: ['Hello'] }] }, ctx)
      await officeExtractTemplateTool.execute(
        {
          sourcePath: 'documents/a.docx',
          action: 'apply',
          templateName: '../../etc/sneaky.docx',
          replacements: [{ text: 'Hello', placeholder: 'greeting' }]
        },
        ctx
      )
      const info = await stat(join(root, 'templates', 'sneaky.docx'))
      expect(info.size).toBeGreaterThan(0)
    })

    it('warns, without failing, about a replacement that matched nothing', async () => {
      await officeCreateDocumentTool.execute({ path: 'a.docx', sections: [{ paragraphs: ['Hello'] }] }, ctx)
      const result = await officeExtractTemplateTool.execute(
        {
          sourcePath: 'documents/a.docx',
          action: 'apply',
          templateName: 't.docx',
          replacements: [{ text: 'Nonexistent Text', placeholder: 'x' }]
        },
        ctx
      )
      expect(result).toContain('Warning: 1 replacement(s) matched nothing')
      expect(result).toContain('"Nonexistent Text"')
    })

    it('supports replacing only a specific 1-based occurrence, leaving the others untouched', async () => {
      await officeCreateDocumentTool.execute(
        { path: 'a.docx', sections: [{ paragraphs: ['First: $10.00', 'Second: $10.00', 'Third: $10.00'] }] },
        ctx
      )
      await officeExtractTemplateTool.execute(
        {
          sourcePath: 'documents/a.docx',
          action: 'apply',
          templateName: 't.docx',
          replacements: [{ text: '$10.00', placeholder: 'onlySecond', occurrence: 2 }]
        },
        ctx
      )
      const runs = await extractDocxRuns(await readFile(join(root, 'templates', 't.docx')))
      expect(runs).toContain('First: $10.00')
      expect(runs).toContain('Second: {onlySecond}')
      expect(runs).toContain('Third: $10.00')
    })

    it('regenerates fresh from the original source on every call — refining replacements never compounds on a previous template attempt', async () => {
      await officeCreateDocumentTool.execute(
        { path: 'a.docx', sections: [{ paragraphs: ['Client: Acme Corp', 'Total: $10.00'] }] },
        ctx
      )
      await officeExtractTemplateTool.execute(
        {
          sourcePath: 'documents/a.docx',
          action: 'apply',
          templateName: 't.docx',
          replacements: [{ text: 'Acme Corp', placeholder: 'client' }]
        },
        ctx
      )
      // Refine: drop the first replacement, add a different one — if apply
      // were compounding on its own prior output, "Acme Corp" would already
      // be gone and this second call would be a no-op for that text.
      await officeExtractTemplateTool.execute(
        {
          sourcePath: 'documents/a.docx',
          action: 'apply',
          templateName: 't.docx',
          replacements: [{ text: '$10.00', placeholder: 'total' }]
        },
        ctx
      )
      const runs = await extractDocxRuns(await readFile(join(root, 'templates', 't.docx')))
      expect(runs).toContain('Client: Acme Corp')
      expect(runs).toContain('Total: {total}')
    })

    it('rejects a placeholder name that is not a valid identifier', async () => {
      await officeCreateDocumentTool.execute({ path: 'a.docx', sections: [{ paragraphs: ['Hello'] }] }, ctx)
      await expect(
        officeExtractTemplateTool.execute(
          {
            sourcePath: 'documents/a.docx',
            action: 'apply',
            templateName: 't.docx',
            replacements: [{ text: 'Hello', placeholder: 'not a valid name!' }]
          },
          ctx
        )
      ).rejects.toThrow(/invalid/)
    })

    it('rejects apply with no replacements', async () => {
      await officeCreateDocumentTool.execute({ path: 'a.docx', sections: [{ paragraphs: ['Hello'] }] }, ctx)
      await expect(
        officeExtractTemplateTool.execute({ sourcePath: 'documents/a.docx', action: 'apply', templateName: 't.docx' }, ctx)
      ).rejects.toThrow(/replacements.*required/)
    })

    it('rejects a templateName extension that does not match the source', async () => {
      await officeCreateDocumentTool.execute({ path: 'a.docx', sections: [{ paragraphs: ['Hello'] }] }, ctx)
      await expect(
        officeExtractTemplateTool.execute(
          {
            sourcePath: 'documents/a.docx',
            action: 'apply',
            templateName: 't.pptx',
            replacements: [{ text: 'Hello', placeholder: 'x' }]
          },
          ctx
        )
      ).rejects.toThrow(/same ".docx" extension/)
    })
  })

  describe('text split across runs', () => {
    async function writeSplitDocx(name: string, bodyXml: string): Promise<void> {
      const zip = new PizZip()
      zip.file(
        '[Content_Types].xml',
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
      )
      zip.file(
        '_rels/.rels',
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
      )
      zip.file(
        'word/document.xml',
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`
      )
      const { mkdir, writeFile } = await import('node:fs/promises')
      await mkdir(join(root, 'documents'), { recursive: true })
      await writeFile(join(root, 'documents', name), zip.generate({ type: 'nodebuffer' }))
    }

    it('replaces a name Word split over several runs, keeping the first run\'s formatting', async () => {
      await writeSplitDocx(
        'split.docx',
        '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Sar</w:t></w:r><w:r><w:t xml:space="preserve">ang Puran</w:t></w:r><w:r><w:t>dare &amp; Co</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>Contact Sarang Purandare today. Sarang Purandare.</w:t></w:r></w:p>'
      )
      const result = await officeExtractTemplateTool.execute(
        {
          sourcePath: 'documents/split.docx',
          action: 'apply',
          templateName: 'split.docx',
          replacements: [{ text: 'Sarang Purandare', placeholder: 'fullName' }]
        },
        ctx
      )
      expect(result).toContain('{fullName}: 3 replacement(s)')
      expect(result).not.toContain('Warning')
      const xml = new PizZip(await readFile(join(root, 'templates', 'split.docx'))).file('word/document.xml')!.asText()
      expect(xml).toContain('<w:rPr><w:b/></w:rPr><w:t>{fullName}</w:t>')
      expect(xml).toContain('<w:t> &amp; Co</w:t>')
      expect(xml).toContain('Contact {fullName} today. {fullName}.')
      expect(xml).not.toContain('Purandare')
    })

    it('honours "occurrence" in document order and does not match across paragraphs', async () => {
      await writeSplitDocx(
        'occ.docx',
        '<w:p><w:r><w:t>Ann</w:t></w:r><w:r><w:t> Lee</w:t></w:r></w:p><w:p><w:r><w:t>Ann</w:t></w:r></w:p><w:p><w:r><w:t> Lee</w:t></w:r></w:p>'
      )
      await officeExtractTemplateTool.execute(
        {
          sourcePath: 'documents/occ.docx',
          action: 'apply',
          templateName: 'occ.docx',
          replacements: [{ text: 'Ann Lee', placeholder: 'who', occurrence: 1 }]
        },
        ctx
      )
      const xml = new PizZip(await readFile(join(root, 'templates', 'occ.docx'))).file('word/document.xml')!.asText()
      expect(xml.match(/\{who\}/g)).toHaveLength(1)
      expect(xml).toContain('<w:t>Ann</w:t></w:r></w:p><w:p><w:r><w:t> Lee')
    })

    it('reports how much of the original text still has no placeholder', async () => {
      await writeSplitDocx(
        'left.docx',
        '<w:p><w:r><w:t>Jane Roe</w:t></w:r></w:p><w:p><w:r><w:t>Led the migration of the billing platform to the cloud.</w:t></w:r></w:p><w:p><w:r><w:t>Skills</w:t></w:r></w:p>'
      )
      const result = await officeExtractTemplateTool.execute(
        {
          sourcePath: 'documents/left.docx',
          action: 'apply',
          templateName: 'left.docx',
          replacements: [{ text: 'Jane Roe', placeholder: 'name' }]
        },
        ctx
      )
      expect(result).toContain('Still the original text: 2 of 3 paragraphs/cells have no placeholder')
      expect(result).toContain('Led the migration of the billing platform')
      expect(result).toContain('A template should hold none of the source')
    })
  })

  describe('real round-trip with office_fill_template', () => {
    it('a template this tool produces is correctly inspected and filled by office_fill_template — the actual point of this feature', async () => {
      await officeCreateDocumentTool.execute(
        {
          path: 'invoice.docx',
          sections: [{ paragraphs: ['Invoice for Acme Corp', 'Amount Due: $1,250.00'] }]
        },
        ctx
      )
      await officeExtractTemplateTool.execute(
        {
          sourcePath: 'documents/invoice.docx',
          action: 'apply',
          templateName: 'invoice-template.docx',
          replacements: [
            { text: 'Acme Corp', placeholder: 'customerName' },
            { text: '$1,250.00', placeholder: 'amountDue' }
          ]
        },
        ctx
      )

      const inspected = await officeFillTemplateTool.execute(
        { templatePath: 'templates/invoice-template.docx', action: 'inspect' },
        ctx
      )
      expect(inspected).toContain('{customerName}')
      expect(inspected).toContain('{amountDue}')

      await officeFillTemplateTool.execute(
        {
          templatePath: 'templates/invoice-template.docx',
          outputPath: 'filled.docx',
          data: { customerName: 'Wonka Industries', amountDue: '$9,999.00' }
        },
        ctx
      )
      const filledRuns = await extractDocxRuns(await readFile(join(root, 'documents', 'filled.docx')))
      expect(filledRuns).toContain('Invoice for Wonka Industries')
      expect(filledRuns).toContain('Amount Due: $9,999.00')
    })
  })
})
