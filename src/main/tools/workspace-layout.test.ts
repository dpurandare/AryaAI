import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import { LOOSE_FILE_SWEEP_THRESHOLD, classifyManagedFolder, pruneScratchDir, resolveNewFilePath, tidyRootStrays, workspaceRelativePath } from './workspace-layout'
import { existsSync } from 'node:fs'
import { utimes } from 'node:fs/promises'

describe('classifyManagedFolder', () => {
  it('classifies code, document, and resource extensions correctly', () => {
    expect(classifyManagedFolder('script.py')).toBe('code')
    expect(classifyManagedFolder('foo/bar.ts')).toBe('code')
    expect(classifyManagedFolder('report.docx')).toBe('documents')
    expect(classifyManagedFolder('sheet.xlsx')).toBe('documents')
    expect(classifyManagedFolder('photo.png')).toBe('resources')
    expect(classifyManagedFolder('clip.mp4')).toBe('resources')
  })

  it('returns null for extensions with no managed folder', () => {
    expect(classifyManagedFolder('notes.txt')).toBeNull()
    expect(classifyManagedFolder('data.csv')).toBeNull()
    expect(classifyManagedFolder('noextension')).toBeNull()
  })
})

describe('resolveNewFilePath', () => {
  let root: string
  let guard: WorkspaceGuard

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-workspace-layout-'))
    guard = new WorkspaceGuard(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('routes a new file of a managed kind into its folder', () => {
    const absPath = resolveNewFilePath(guard, 'script.py')
    expect(relative(root, absPath)).toBe(join('code', 'script.py'))
  })

  it('leaves an unclassified extension at the given path', () => {
    const absPath = resolveNewFilePath(guard, 'notes.txt')
    expect(relative(root, absPath)).toBe('notes.txt')
  })

  it('does not double-nest a path the model already placed under a managed folder', () => {
    const absPath = resolveNewFilePath(guard, 'code/scripts/foo.py')
    expect(relative(root, absPath)).toBe(join('code', 'scripts', 'foo.py'))
  })

  it('never redirects a path that already exists on disk', async () => {
    await mkdir(join(root, 'archive'), { recursive: true })
    await writeFile(join(root, 'archive', 'legacy.xlsx'), '')
    const absPath = resolveNewFilePath(guard, 'archive/legacy.xlsx')
    expect(relative(root, absPath)).toBe(join('archive', 'legacy.xlsx'))
  })

  it('leaves a pre-existing templates/ path untouched even for a managed extension', () => {
    const absPath = resolveNewFilePath(guard, 'templates/letter.docx')
    expect(relative(root, absPath)).toBe(join('templates', 'letter.docx'))
  })

  it('leaves a .sachiv-clones/ path untouched even for a managed extension', () => {
    const absPath = resolveNewFilePath(guard, '.sachiv-clones/some-repo-abc123/setup.py')
    expect(relative(root, absPath)).toBe(join('.sachiv-clones', 'some-repo-abc123', 'setup.py'))
  })

  it('respects the workspace boundary', () => {
    expect(() => resolveNewFilePath(guard, '../escape.py')).toThrow(/workspace boundary/)
  })
})

describe('workspaceRelativePath', () => {
  it('reports a workspace-relative path with forward slashes on every platform', () => {
    const root = join('base', 'ws')
    expect(workspaceRelativePath(root, join(root, 'documents', 'report.docx'))).toBe('documents/report.docx')
  })
})

describe('tidyRootStrays and pruneScratchDir', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-tidy-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const make = async (...names: string[]): Promise<void> => {
    for (const n of names) await writeFile(join(root, n), 'x')
  }

  it('does nothing below the threshold, so one or two requested outputs stay where the script wrote them', async () => {
    await make('answer.json', 'report.docx')
    expect(LOOSE_FILE_SWEEP_THRESHOLD).toBe(4)
    expect(await tidyRootStrays(root, ['answer.json', 'report.docx'])).toEqual([])
    expect(existsSync(join(root, 'answer.json'))).toBe(true)
  })

  it('files a bulk by the managed-folder convention, anything else to tmp/, and numbers a clash', async () => {
    await make('a.png', 'b.docx', 'c.py', 'd.csv', 'e.csv')
    await mkdir(join(root, 'tmp'), { recursive: true })
    await writeFile(join(root, 'tmp', 'd.csv'), 'older')
    const moved = await tidyRootStrays(root, ['a.png', 'b.docx', 'c.py', 'd.csv', 'e.csv'])
    expect(moved.map((m) => `${m.from}>${m.to}`)).toEqual(['a.png>resources/a.png', 'b.docx>documents/b.docx', 'c.py>code/c.py', 'd.csv>tmp/d-2.csv', 'e.csv>tmp/e.csv'])
    expect(existsSync(join(root, 'resources', 'a.png'))).toBe(true)
    expect(existsSync(join(root, 'a.png'))).toBe(false)
  })

  it('never touches files already inside a folder, hidden files or anything not created by the run', async () => {
    await make('p1.png', 'p2.png', 'p3.png', 'p4.png', '.hidden', 'old.txt')
    await mkdir(join(root, 'sub'), { recursive: true })
    await writeFile(join(root, 'sub', 'inner.png'), 'x')
    const moved = await tidyRootStrays(root, ['p1.png', 'p2.png', 'p3.png', 'p4.png', '.hidden', 'sub/inner.png'])
    expect(moved).toHaveLength(4)
    expect(existsSync(join(root, '.hidden'))).toBe(true)
    expect(existsSync(join(root, 'old.txt'))).toBe(true)
    expect(existsSync(join(root, 'sub', 'inner.png'))).toBe(true)
  })

  it('prunes only old files under tmp/, and removes the folders it empties', async () => {
    await mkdir(join(root, 'tmp', 'deep'), { recursive: true })
    await writeFile(join(root, 'tmp', 'old.png'), 'x')
    await writeFile(join(root, 'tmp', 'deep', 'old2.png'), 'x')
    await writeFile(join(root, 'tmp', 'fresh.png'), 'x')
    await writeFile(join(root, 'keep.png'), 'x')
    const longAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000)
    await utimes(join(root, 'tmp', 'old.png'), longAgo, longAgo)
    await utimes(join(root, 'tmp', 'deep', 'old2.png'), longAgo, longAgo)
    await pruneScratchDir(root, 7 * 24 * 3600 * 1000)
    expect(existsSync(join(root, 'tmp', 'old.png'))).toBe(false)
    expect(existsSync(join(root, 'tmp', 'deep'))).toBe(false)
    expect(existsSync(join(root, 'tmp', 'fresh.png'))).toBe(true)
    expect(existsSync(join(root, 'keep.png'))).toBe(true)
  })
})
