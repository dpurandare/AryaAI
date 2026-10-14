import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Tool } from './types'
import { SCRATCH_DIR } from './workspace-layout'

const MAX_NOTE_CHARS = 8_000
const MAX_FILE_BYTES = 200_000
const MAX_READ_CHARS = 80_000

/**
 * A run keeps only the three most recent results of any one tool in full (orchestrator.ts's capRepeatedToolResults), so
 * a research pass that reads ten pages would lose the first seven. The Researcher writes what it learned from each page
 * here as it goes and reads the whole notebook back once, at the end, to write the result. Stored in tmp/ (scratch,
 * cleared after a week), one file per notebook per chat.
 */
function notebookPath(root: string, sessionId: string, notebook: unknown): string {
  const slug = String(notebook ?? 'notes').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'notes'
  return join(root, SCRATCH_DIR, `research-${slug}-${(sessionId || 'session').slice(0, 8)}.md`)
}

export const saveResearchNoteTool: Tool = {
  name: 'save_research_note',
  description:
    'Record what you just learned for a research task — facts, figures, dates, examples, each with its source URL — under a ' +
    'section heading. Do this after every page or batch you read: older tool results are dropped from view as the run goes ' +
    'on, notes are not. Read them all back with read_research_notes before writing the result.',
  inputSchema: {
    type: 'object',
    properties: {
      section: { type: 'string', description: 'The sub-topic this belongs to, e.g. "Market size", "Security risks"' },
      content: { type: 'string', description: 'The facts, one per line, each ending with its source URL' },
      notebook: { type: 'string', description: 'Only to keep two separate research tasks apart; default "notes"' }
    },
    required: ['section', 'content']
  },
  mutates: false,
  async execute(input, ctx) {
    const section = String(input.section ?? '').trim()
    const content = String(input.content ?? '').trim()
    if (!section || !content) throw new Error('A note needs a "section" and some "content".')
    const path = notebookPath(ctx.workspaceGuard.root, ctx.currentSessionId, input.notebook)
    await mkdir(join(ctx.workspaceGuard.root, SCRATCH_DIR), { recursive: true })
    const size = await stat(path).then((s) => s.size).catch(() => 0)
    if (size > MAX_FILE_BYTES) throw new Error('The notebook is full — read it with read_research_notes and write the result from it.')
    const clipped = content.length > MAX_NOTE_CHARS ? `${content.slice(0, MAX_NOTE_CHARS)}\n[...note truncated]` : content
    await appendFile(path, `\n## ${section}\n${clipped}\n`, 'utf-8')
    return `Saved a note under "${section}" (${clipped.length} characters).`
  }
}

export const readResearchNotesTool: Tool = {
  name: 'read_research_notes',
  description: 'Read back everything saved with save_research_note, in order. Call it once, at the end, then write the result from it.',
  inputSchema: { type: 'object', properties: { notebook: { type: 'string', description: 'Default "notes"' } } },
  mutates: false,
  async execute(input, ctx) {
    const path = notebookPath(ctx.workspaceGuard.root, ctx.currentSessionId, input.notebook)
    const text = await readFile(path, 'utf-8').catch(() => '')
    if (!text.trim()) return 'No notes saved yet.'
    return text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n[...notes truncated at ${MAX_READ_CHARS} characters]` : text
  }
}
