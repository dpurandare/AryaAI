import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import { findFilesTool } from './find-files'
import type { ToolContext } from './types'

async function touch(root: string, relPath: string): Promise<void> {
  const full = join(root, relPath)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, 'x')
}

describe('find_files', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-findfiles-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("does not return files from Sachivji's own .sachiv-handoff folder (TASKS #238)", async () => {
    await touch(root, '.sachiv-handoff/turn1/rows.json')
    await touch(root, 'data/rows.json')
    const out = await findFilesTool.execute({ pattern: '**/rows.json' }, ctx)
    expect(out).toContain('data/rows.json')
    expect(out).not.toContain('.sachiv-handoff')
  })

  it('finds files matching a ** glob across nested directories', async () => {
    await touch(root, 'charts/2020.png')
    await touch(root, 'charts/nested/2021.png')
    await touch(root, 'code/generate_chart.py')

    const result = await findFilesTool.execute({ pattern: '**/*.png' }, ctx)
    expect(result).toContain('charts/2020.png')
    expect(result).toContain('charts/nested/2021.png')
    expect(result).not.toContain('generate_chart.py')
  })

  it('a bare * only matches within one path segment, not across directories', async () => {
    await touch(root, 'code/a.py')
    await touch(root, 'code/nested/b.py')

    const result = await findFilesTool.execute({ path: 'code', pattern: '*.py' }, ctx)
    expect(result).toContain('code/a.py')
    expect(result).not.toContain('nested/b.py')
  })

  it('never descends into default-ignored directories (node_modules, .git, venv)', async () => {
    await touch(root, 'node_modules/pkg/index.js')
    await touch(root, '.git/HEAD')
    await touch(root, 'venv/lib/site.py')
    await touch(root, 'code/real.py')

    const result = await findFilesTool.execute({ pattern: '**/*' }, ctx)
    expect(result).not.toContain('node_modules')
    expect(result).not.toContain('.git/HEAD')
    expect(result).not.toContain('venv/lib')
    expect(result).toContain('code/real.py')
  })

  it('respects a basic .gitignore pattern (basename match)', async () => {
    await writeFile(join(root, '.gitignore'), '*.log\ntemp/\n')
    await touch(root, 'debug.log')
    await touch(root, 'temp/scratch.txt')
    await touch(root, 'code/real.py')

    const result = await findFilesTool.execute({ pattern: '**/*' }, ctx)
    expect(result).not.toContain('debug.log')
    expect(result).not.toContain('temp/scratch.txt')
    expect(result).toContain('code/real.py')
  })

  it('returns paths relative to the workspace root even when searching a subdirectory', async () => {
    await touch(root, 'documents/report.docx')
    const result = await findFilesTool.execute({ path: 'documents', pattern: '*' }, ctx)
    expect(result).toContain('documents/report.docx')
  })

  it('reports a clear no-match message rather than an empty string', async () => {
    await touch(root, 'code/real.py')
    const result = await findFilesTool.execute({ pattern: '**/*.png' }, ctx)
    expect(result).toBe('No files matched "**/*.png".')
  })

  it('sorts results', async () => {
    await touch(root, 'b.txt')
    await touch(root, 'a.txt')
    const result = await findFilesTool.execute({ pattern: '*.txt' }, ctx)
    const lines = result.split('\n').slice(1)
    expect(lines).toEqual(['a.txt', 'b.txt'])
  })

  it('refuses to search outside the workspace', async () => {
    await expect(findFilesTool.execute({ path: '../outside' }, ctx)).rejects.toThrow(/outside the workspace/)
  })

  it('is read-only (mutates: false)', () => {
    expect(findFilesTool.mutates).toBe(false)
  })
})
