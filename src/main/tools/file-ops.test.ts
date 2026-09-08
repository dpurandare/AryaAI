import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import { listDirectoryTool, readFileTool, writeFileTool } from './file-ops'
import type { ToolContext } from './types'

describe('file-ops tools', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-fileops-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  describe('write_file', () => {
    it('creates a file with the given content', async () => {
      const result = await writeFileTool.execute({ path: 'note.txt', content: 'hello' }, ctx)
      expect(result).toContain('note.txt')
      expect(await readFile(join(root, 'note.txt'), 'utf-8')).toBe('hello')
    })

    it('creates parent directories as needed', async () => {
      await writeFileTool.execute({ path: 'a/b/c.txt', content: 'nested' }, ctx)
      expect(await readFile(join(root, 'a', 'b', 'c.txt'), 'utf-8')).toBe('nested')
    })

    it('overwrites an existing file', async () => {
      await writeFileTool.execute({ path: 'note.txt', content: 'first' }, ctx)
      await writeFileTool.execute({ path: 'note.txt', content: 'second' }, ctx)
      expect(await readFile(join(root, 'note.txt'), 'utf-8')).toBe('second')
    })

    it('refuses to write outside the workspace', async () => {
      await expect(
        writeFileTool.execute({ path: '../outside.txt', content: 'x' }, ctx)
      ).rejects.toThrow(/outside the workspace/)
    })

    it('is marked as mutating', () => {
      expect(writeFileTool.mutates).toBe(true)
    })

    it('describes the write for the confirmation dialog', () => {
      expect(writeFileTool.describe?.({ path: 'note.txt', content: 'hello' })).toBe(
        'Write 5 characters to "note.txt"'
      )
    })
  })

  describe('read_file', () => {
    it('reads back a written file', async () => {
      await writeFileTool.execute({ path: 'note.txt', content: 'hello' }, ctx)
      expect(await readFileTool.execute({ path: 'note.txt' }, ctx)).toBe('hello')
    })

    it('refuses to read outside the workspace', async () => {
      await expect(readFileTool.execute({ path: '../outside.txt' }, ctx)).rejects.toThrow(
        /outside the workspace/
      )
    })

    it('rejects a file over the read-size limit', async () => {
      const big = 'x'.repeat(200_001)
      await writeFileTool.execute({ path: 'big.txt', content: big }, ctx)
      await expect(readFileTool.execute({ path: 'big.txt' }, ctx)).rejects.toThrow(
        /over the 200000-byte read limit/
      )
    })

    it('is not marked as mutating', () => {
      expect(readFileTool.mutates).toBe(false)
    })
  })

  describe('list_directory', () => {
    it('lists files and subdirectories', async () => {
      await writeFileTool.execute({ path: 'a.txt', content: '1' }, ctx)
      await writeFileTool.execute({ path: 'sub/b.txt', content: '2' }, ctx)
      const listing = await listDirectoryTool.execute({}, ctx)
      expect(listing).toContain('file  a.txt')
      expect(listing).toContain('dir   sub')
    })

    it('reports an empty directory', async () => {
      expect(await listDirectoryTool.execute({}, ctx)).toBe('(empty directory)')
    })

    it('lists a nested path', async () => {
      await writeFileTool.execute({ path: 'sub/b.txt', content: '2' }, ctx)
      expect(await listDirectoryTool.execute({ path: 'sub' }, ctx)).toBe('file  b.txt')
    })
  })
})
