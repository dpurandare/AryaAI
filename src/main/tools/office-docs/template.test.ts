import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import type { ToolContext } from '../types'
import { officeCreateDocumentTool } from './create'
import { officeFillTemplateTool } from './template'
import { officeReadDocumentTool } from './read'

describe('office_fill_template', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-office-template-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('mutates only for the fill action, not inspect', () => {
    const mutates = officeFillTemplateTool.mutates as (input: Record<string, unknown>) => boolean
    expect(mutates({ action: 'inspect' })).toBe(false)
    expect(mutates({ action: 'fill' })).toBe(true)
    expect(mutates({})).toBe(true)
  })

  it('inspects a real .docx template and lists its placeholders', async () => {
    await officeCreateDocumentTool.execute(
      { path: 'templates/letter.docx', sections: [{ paragraphs: ['Hello {name}, your total is {total}.'] }] },
      ctx
    )
    const result = await officeFillTemplateTool.execute({ templatePath: 'templates/letter.docx', action: 'inspect' }, ctx)
    expect(result).toContain('{name}')
    expect(result).toContain('{total}')
  })

  it('fills a real .docx template, preserving everything but the substituted values', async () => {
    await officeCreateDocumentTool.execute(
      { path: 'templates/letter.docx', sections: [{ paragraphs: ['Hello {name}, your total is {total}.'] }] },
      ctx
    )
    const result = await officeFillTemplateTool.execute(
      { templatePath: 'templates/letter.docx', outputPath: 'out/letter-ada.docx', data: { name: 'Ada', total: '42' } },
      ctx
    )
    expect(result).toBe('Filled template written to documents/out/letter-ada.docx.')
    const text = await officeReadDocumentTool.execute({ path: 'documents/out/letter-ada.docx' }, ctx)
    expect(text).toContain('Hello Ada, your total is 42.')
  })

  it('fills a real .pptx template too, not just docx', async () => {
    await officeCreateDocumentTool.execute(
      { path: 'templates/deck.pptx', slides: [{ title: 'Report for {company}' }] },
      ctx
    )
    await officeFillTemplateTool.execute(
      { templatePath: 'templates/deck.pptx', outputPath: 'out/report-acme.pptx', data: { company: 'Acme' } },
      ctx
    )
    const text = await officeReadDocumentTool.execute({ path: 'documents/out/report-acme.pptx' }, ctx)
    expect(text).toContain('Report for Acme')
  })

  it('reports a render error clearly instead of throwing an opaque one', async () => {
    await officeCreateDocumentTool.execute(
      { path: 'templates/bad.docx', sections: [{ paragraphs: ['{#loop}unclosed'] }] },
      ctx
    )
    await expect(
      officeFillTemplateTool.execute({ templatePath: 'templates/bad.docx', outputPath: 'out/bad.docx', data: {} }, ctx)
    ).rejects.toThrow(/Template render failed/)
  })
})
