import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import { classifyManagedFolder, resolveNewFilePath } from './workspace-layout'

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
