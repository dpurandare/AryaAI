import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import { readResearchNotesTool, saveResearchNoteTool } from './research-notes'
import type { ToolContext } from './types'

describe('research notes', () => {
  let root: string
  let ctx: ToolContext
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-notes-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'abcdef12-session' }
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('keeps notes in order under their section headings, in tmp/, and reads them all back', async () => {
    expect(String(await readResearchNotesTool.execute({}, ctx))).toBe('No notes saved yet.')
    await saveResearchNoteTool.execute({ section: 'Market size', content: 'Agents market grows 40% a year (https://example.com/a)' }, ctx)
    await saveResearchNoteTool.execute({ section: 'Security risks', content: 'Prompt injection is the top risk (https://example.com/b)' }, ctx)
    const notes = String(await readResearchNotesTool.execute({}, ctx))
    expect(notes.indexOf('## Market size')).toBeLessThan(notes.indexOf('## Security risks'))
    expect(notes).toContain('40% a year (https://example.com/a)')
    expect(existsSync(join(root, 'tmp', 'research-notes-abcdef12.md'))).toBe(true)
  })

  it('keeps separate notebooks apart, and separate chats apart', async () => {
    await saveResearchNoteTool.execute({ section: 'A', content: 'one', notebook: 'solar' }, ctx)
    await saveResearchNoteTool.execute({ section: 'B', content: 'two', notebook: 'wind' }, ctx)
    expect(String(await readResearchNotesTool.execute({ notebook: 'solar' }, ctx))).not.toContain('two')
    const other = { ...ctx, currentSessionId: 'zzzzzzzz-other' }
    expect(String(await readResearchNotesTool.execute({ notebook: 'solar' }, other))).toBe('No notes saved yet.')
  })

  it('does not ask for confirmation (a note is scratch), rejects an empty note, and clips an oversized one', async () => {
    expect(saveResearchNoteTool.mutates).toBe(false)
    await expect(saveResearchNoteTool.execute({ section: 'X', content: '   ' }, ctx)).rejects.toThrow(/needs a "section" and some "content"/)
    await saveResearchNoteTool.execute({ section: 'Big', content: 'y'.repeat(20_000) }, ctx)
    const raw = await readFile(join(root, 'tmp', 'research-notes-abcdef12.md'), 'utf-8')
    expect(raw).toContain('[...note truncated]')
    expect(raw.length).toBeLessThan(9_000)
  })
})
