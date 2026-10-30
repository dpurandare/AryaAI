import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import { findInFilesTool } from './find-in-files'
import type { ToolContext } from './types'

async function put(root: string, relPath: string, content: string | Buffer): Promise<void> {
  const full = join(root, relPath)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content)
}

describe('find_in_files (#169)', () => {
  let root: string
  let ctx: ToolContext
  const run = (input: Record<string, unknown>) => findInFilesTool.execute(input, ctx) as Promise<string>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-findinfiles-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('finds literal text case-insensitively, with file and line number, and reports the scope', async () => {
    await put(root, 'code/a.py', 'import os\n# TODO fix this\nprint(1)\n')
    await put(root, 'notes.txt', 'nothing here\nand a todo item\n')
    const out = await run({ pattern: 'todo' })
    expect(out).toContain('2 match(es) in 2 file(s)')
    expect(out).toContain('code/a.py')
    expect(out).toContain('  2: # TODO fix this')
    expect(out).toContain('notes.txt')
    expect(out).toContain('  2: and a todo item')
    expect(out).toContain('searched 2 file(s)')
  })

  it('treats regex characters literally unless regex is true, and honours case_sensitive', async () => {
    await put(root, 'a.txt', 'price (USD) 5.00\nprice USD 7\n')
    expect(await run({ pattern: '(USD)' })).toContain('1 match(es)')
    expect(await run({ pattern: 'price.*\\d', regex: true })).toContain('2 match(es)')
    expect(await run({ pattern: 'usd', case_sensitive: true })).toContain('No matches')
  })

  it('reports an invalid regular expression plainly', async () => {
    await expect(run({ pattern: '(', regex: true })).rejects.toThrow(/Invalid regular expression/)
    await expect(run({ pattern: '' })).rejects.toThrow(/pattern is required/)
  })

  it('narrows by path and by glob', async () => {
    await put(root, 'code/a.py', 'needle\n')
    await put(root, 'code/b.js', 'needle\n')
    await put(root, 'docs/c.md', 'needle\n')
    const py = await run({ pattern: 'needle', glob: '**/*.py' })
    expect(py).toContain('code/a.py')
    expect(py).not.toContain('b.js')
    const docs = await run({ pattern: 'needle', path: 'docs' })
    expect(docs).toContain('docs/c.md')
    expect(docs).not.toContain('code/')
  })

  it('shows context lines around a match when asked', async () => {
    await put(root, 'a.txt', 'one\ntwo\nTARGET\nfour\nfive\n')
    const out = await run({ pattern: 'target', context: 1 })
    expect(out).toContain('  2- two')
    expect(out).toContain('  3: TARGET')
    expect(out).toContain('  4- four')
    expect(out).not.toContain('one')
    expect(out).not.toContain('five')
  })

  it('skips binary files (by extension and by content) and large files, and says how many', async () => {
    await put(root, 'ok.txt', 'needle\n')
    await put(root, 'pic.png', 'needle in a png')
    await put(root, 'noext', Buffer.from([110, 101, 0, 0, 101, 100, 108, 101])) // contains NUL bytes
    await put(root, 'big.log', 'needle\n' + 'x'.repeat(1_100_000))
    const out = await run({ pattern: 'needle' })
    expect(out).toContain('1 match(es) in 1 file(s)')
    expect(out).toContain('2 binary file(s) skipped')
    expect(out).toContain('1 file(s) over 1 MB skipped')
  })

  it('never searches node_modules, .git, venv or the .sachiv-handoff folder, and respects .gitignore', async () => {
    await put(root, 'node_modules/x/index.js', 'needle\n')
    await put(root, '.git/config', 'needle\n')
    await put(root, 'venv/lib/x.py', 'needle\n')
    await put(root, '.sachiv-handoff/t/rows.json', 'needle\n')
    await put(root, 'build.log', 'needle\n')
    await put(root, '.gitignore', '*.log\n')
    await put(root, 'src/app.ts', 'needle\n')
    const out = await run({ pattern: 'needle' })
    expect(out).toContain('src/app.ts')
    for (const hidden of ['node_modules', '.git/', 'venv', '.sachiv-handoff', 'build.log']) expect(out).not.toContain(hidden)
  })

  it('caps matches per file and files shown, saying exactly how many are not shown (never a silent cut)', async () => {
    await put(root, 'many.txt', Array.from({ length: 12 }, (_, i) => `hit ${i}`).join('\n'))
    const out = await run({ pattern: 'hit' })
    expect(out).toContain('12 match(es) in 1 file(s)')
    expect(out).toContain('(7 more match(es) in this file not shown)')
    expect(out).not.toContain('hit 5')

    for (let i = 0; i < 40; i++) await put(root, `f${String(i).padStart(2, '0')}.txt`, 'hit\n')
    const capped = await run({ pattern: 'hit' })
    expect(capped).toContain('stopped after 30 files with matches; more files may match')
    expect(capped).toContain('narrow the path, glob or pattern')
  })

  it('answers "no matches" with the scope, and refuses a path outside the workspace that was not allowed', async () => {
    await put(root, 'a.txt', 'hello\n')
    expect(await run({ pattern: 'absent' })).toBe('No matches for "absent" (searched 1 file(s)).')
    await expect(run({ pattern: 'x', path: tmpdir() })).rejects.toThrow(/outside the workspace/)
  })

  it('is read-only and declares the folder it reads so the outside-folder prompt applies', () => {
    expect(findInFilesTool.mutates).toBe(false)
    expect(findInFilesTool.externalPaths?.({ path: '/somewhere' }, ctx)).toEqual([{ path: '/somewhere', access: 'read' }])
  })
})
