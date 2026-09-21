import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import type { ToolContext } from '../types'
import { officeCreateDocumentTool } from './create'

describe('office_create_document', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-office-create-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('always mutates and describes the target path', () => {
    expect(officeCreateDocumentTool.mutates).toBe(true)
    expect(officeCreateDocumentTool.describe?.({ path: 'out.docx' })).toBe('Create "out.docx"')
  })

  it('creates a real, non-empty .docx from sections', async () => {
    const result = await officeCreateDocumentTool.execute(
      { path: 'report.docx', title: 'Q3 Report', sections: [{ heading: 'Summary', paragraphs: ['All good.'], bullets: ['Item one'] }] },
      ctx
    )
    expect(result).toBe('Created report.docx.')
    const info = await stat(join(root, 'report.docx'))
    expect(info.size).toBeGreaterThan(0)
  })

  it('creates a real, non-empty .pptx from slides', async () => {
    const result = await officeCreateDocumentTool.execute(
      { path: 'deck.pptx', title: 'Kickoff', slides: [{ title: 'Agenda', bullets: ['Intro', 'Roadmap'] }] },
      ctx
    )
    expect(result).toBe('Created deck.pptx.')
    const info = await stat(join(root, 'deck.pptx'))
    expect(info.size).toBeGreaterThan(0)
  })

  it('rejects an unsupported extension', async () => {
    await expect(officeCreateDocumentTool.execute({ path: 'notes.txt' }, ctx)).rejects.toThrow(/only supports .docx and .pptx/)
  })

  it('respects the workspace boundary', async () => {
    await expect(officeCreateDocumentTool.execute({ path: '../escape.docx' }, ctx)).rejects.toThrow(/workspace boundary/)
  })
})
