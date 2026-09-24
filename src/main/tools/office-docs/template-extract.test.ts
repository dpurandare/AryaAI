import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
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
