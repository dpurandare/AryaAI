import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
      const result = await writeFileTool.execute({ path: 'note.dat', content: 'hello' }, ctx)
      expect(result).toContain('note.dat')
      expect(await readFile(join(root, 'note.dat'), 'utf-8')).toBe('hello')
    })

    it('creates parent directories as needed', async () => {
      await writeFileTool.execute({ path: 'a/b/c.dat', content: 'nested' }, ctx)
      expect(await readFile(join(root, 'a', 'b', 'c.dat'), 'utf-8')).toBe('nested')
    })

    it('overwrites an existing file', async () => {
      await writeFileTool.execute({ path: 'note.dat', content: 'first' }, ctx)
      await writeFileTool.execute({ path: 'note.dat', content: 'second' }, ctx)
      expect(await readFile(join(root, 'note.dat'), 'utf-8')).toBe('second')
    })

    it('refuses to write outside the workspace', async () => {
      await expect(
        writeFileTool.execute({ path: '../outside.txt', content: 'x' }, ctx)
      ).rejects.toThrow(/outside the workspace/)
    })

    // Found live (the Northwind bar-chart session): write_file overwrote a real .docx made by office_create_document with 174 characters of markdown.
    it('refuses to overwrite an existing .docx with text, leaving the real file untouched', async () => {
      const real = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff])
      await mkdir(join(root, 'documents'), { recursive: true })
      await writeFile(join(root, 'documents', 'report.docx'), real)
      await expect(writeFileTool.execute({ path: 'documents/report.docx', content: '# Report' }, ctx)).rejects.toThrow(/corrupt a \.docx/)
      expect(Buffer.compare(await readFile(join(root, 'documents', 'report.docx')), real)).toBe(0)
    })

    it('names the right tool for each kind of binary format', async () => {
      await expect(writeFileTool.execute({ path: 'a.docx', content: 'x' }, ctx)).rejects.toThrow(/office_create_document/)
      await expect(writeFileTool.execute({ path: 'a.xlsx', content: 'x' }, ctx)).rejects.toThrow(/xlsx_write/)
      await expect(writeFileTool.execute({ path: 'a.pptx', content: 'x' }, ctx)).rejects.toThrow(/pptx_save_deck/)
      await expect(writeFileTool.execute({ path: 'chart.png', content: 'x' }, ctx)).rejects.toThrow(/shell_execute/)
    })

    it('matches the extension case-insensitively and writes nothing for a refused path', async () => {
      await expect(writeFileTool.execute({ path: 'Report.DOCX', content: 'x' }, ctx)).rejects.toThrow(/corrupt/)
      await expect(readFile(join(root, 'Report.DOCX'), 'utf-8')).rejects.toThrow()
      await expect(readFile(join(root, 'documents', 'Report.DOCX'), 'utf-8')).rejects.toThrow()
    })

    it('still writes ordinary text formats, including ones that live under documents/ or resources/', async () => {
      for (const path of ['notes.md', 'data.csv', 'data.json', 'script.py', 'diagram.svg', 'page.html']) {
        await expect(writeFileTool.execute({ path, content: 'text' }, ctx)).resolves.toContain('Wrote')
      }
    })

    it('is marked as mutating', () => {
      expect(writeFileTool.mutates).toBe(true)
    })

    it('describes the write for the confirmation dialog', () => {
      expect(writeFileTool.describe?.({ path: 'note.dat', content: 'hello' })).toBe(
        'Write 5 characters to "note.dat"'
      )
    })

    it('places a brand-new code file under code/ regardless of the path given, and says so in the result', async () => {
      const result = await writeFileTool.execute({ path: 'generate_chart.py', content: 'print(1)' }, ctx)
      expect(result).toContain('code/generate_chart.py')
      expect(await readFile(join(root, 'code', 'generate_chart.py'), 'utf-8')).toBe('print(1)')
    })

    it('preserves a model-given subfolder under the managed folder rather than flattening it', async () => {
      await writeFileTool.execute({ path: 'scripts/build.sh', content: '#!/bin/sh' }, ctx)
      expect(await readFile(join(root, 'code', 'scripts', 'build.sh'), 'utf-8')).toBe('#!/bin/sh')
    })

    it('does not double-nest a path that already explicitly targets the managed folder', async () => {
      await writeFileTool.execute({ path: 'code/already-there.py', content: 'x' }, ctx)
      expect(await readFile(join(root, 'code', 'already-there.py'), 'utf-8')).toBe('x')
    })

    it('tells the model the real path when a new code file is filed under code/', async () => {
      const result = await writeFileTool.execute({ path: 'run.sh', content: 'echo hi' }, ctx)
      expect(result).toContain('Wrote 7 characters to code/run.sh.')
      expect(result).toContain('use "code/run.sh" (not "run.sh")')
    })

    it('keeps a script written under tmp/ at tmp/, so the run step finds it', async () => {
      const result = await writeFileTool.execute({ path: 'tmp/date_script.sh', content: 'date' }, ctx)
      expect(result).toBe('Wrote 4 characters to tmp/date_script.sh.')
      expect(await readFile(join(root, 'tmp', 'date_script.sh'), 'utf-8')).toBe('date')
    })

    it('an unclassified extension stays at the given (root-relative) path, unaffected', async () => {
      const result = await writeFileTool.execute({ path: 'note.dat', content: 'hello' }, ctx)
      expect(result).toBe('Wrote 5 characters to note.dat.')
    })

    it('overwriting a code file that already exists elsewhere writes back there, not into code/', async () => {
      // Found live risk: reclassifying every write, not just creation, would
      // silently create a second copy in a different folder the moment an
      // existing file (e.g. one the user placed themselves, pre-dating this
      // convention) got overwritten — set up directly via fs, not via
      // write_file, so this really is "already there" rather than something
      // the tool itself already redirected.
      await mkdir(join(root, 'legacy'), { recursive: true })
      await writeFile(join(root, 'legacy', 'old_script.py'), 'v1', 'utf-8')

      const result = await writeFileTool.execute({ path: 'legacy/old_script.py', content: 'v2' }, ctx)
      expect(result).toContain('legacy/old_script.py')
      expect(await readFile(join(root, 'legacy', 'old_script.py'), 'utf-8')).toBe('v2')
      await expect(readFile(join(root, 'code', 'legacy', 'old_script.py'), 'utf-8')).rejects.toThrow()
    })
  })

  describe('read_file', () => {
    it('reads back a written file', async () => {
      await writeFileTool.execute({ path: 'note.dat', content: 'hello' }, ctx)
      expect(await readFileTool.execute({ path: 'note.dat' }, ctx)).toBe('hello')
    })

    it('refuses to read outside the workspace', async () => {
      await expect(readFileTool.execute({ path: '../outside.txt' }, ctx)).rejects.toThrow(
        /outside the workspace/
      )
    })

    it('rejects a file over the read-size limit', async () => {
      const big = 'x'.repeat(200_001)
      await writeFileTool.execute({ path: 'big.dat', content: big }, ctx)
      await expect(readFileTool.execute({ path: 'big.dat' }, ctx)).rejects.toThrow(
        /over the 200000-byte read limit/
      )
    })

    it('is not marked as mutating', () => {
      expect(readFileTool.mutates).toBe(false)
    })
  })

  describe('list_directory', () => {
    it('lists files and subdirectories', async () => {
      await writeFileTool.execute({ path: 'a.dat', content: '1' }, ctx)
      await writeFileTool.execute({ path: 'sub/b.dat', content: '2' }, ctx)
      const listing = await listDirectoryTool.execute({}, ctx)
      expect(listing).toContain('file  a.dat')
      expect(listing).toContain('dir   sub')
    })

    it("never shows Sachivji's own .sachiv-handoff folder (TASKS #238)", async () => {
      await writeFileTool.execute({ path: 'a.dat', content: '1' }, ctx)
      await mkdir(join(root, '.sachiv-handoff', 'turn1'), { recursive: true })
      const listing = await listDirectoryTool.execute({}, ctx)
      expect(listing).toContain('file  a.dat')
      expect(listing).not.toContain('.sachiv-handoff')
    })

    it('reports an empty directory', async () => {
      expect(await listDirectoryTool.execute({}, ctx)).toBe('(empty directory)')
    })

    it('lists a nested path', async () => {
      await writeFileTool.execute({ path: 'sub/b.dat', content: '2' }, ctx)
      expect(await listDirectoryTool.execute({ path: 'sub' }, ctx)).toBe('file  b.dat')
    })

    describe('with a depth (#238)', () => {
      beforeEach(async () => {
        for (const rel of ['code/a.py', 'code/lib/util.py', 'code/lib/deep/x.py', 'documents/r.docx', 'top.dat']) {
          await mkdir(join(root, dirname(rel)), { recursive: true })
          await writeFile(join(root, rel), 'x')
        }
      })

      it('depth 1 (or none) is the unchanged one-level listing', async () => {
        const plain = await listDirectoryTool.execute({}, ctx)
        expect(await listDirectoryTool.execute({ depth: 1 }, ctx)).toBe(plain)
        expect(plain).toBe('dir   code\ndir   documents\nfile  top.dat')
      })

      it('depth 2 lists each folder followed by its contents, names relative to the listed folder with /', async () => {
        const out = await listDirectoryTool.execute({ depth: 2 }, ctx)
        expect(out.split('\n')).toEqual([
          'dir   code',
          'dir   code/lib',
          'file  code/a.py',
          'dir   documents',
          'file  documents/r.docx',
          'file  top.dat'
        ])
      })

      it('depth 3 goes one level further, and depth is capped at 3', async () => {
        const three = await listDirectoryTool.execute({ depth: 3 }, ctx)
        expect(three).toContain('dir   code/lib/deep')
        expect(three).toContain('file  code/lib/util.py')
        expect(three).not.toContain('x.py')
        expect(await listDirectoryTool.execute({ depth: 99 }, ctx)).toBe(three)
        expect(await listDirectoryTool.execute({ depth: 'abc' }, ctx)).toBe(await listDirectoryTool.execute({}, ctx))
      })

      it('shows but does not open venv, node_modules, .git, tmp and the clones folder, and says so', async () => {
        for (const d of ['venv/lib', 'node_modules/x', 'tmp/scratch', '.git/objects']) await mkdir(join(root, d), { recursive: true })
        await writeFile(join(root, 'venv/lib/big.py'), 'x')
        const out = await listDirectoryTool.execute({ depth: 3 }, ctx)
        for (const d of ['dir   venv', 'dir   node_modules', 'dir   tmp', 'dir   .git']) expect(out).toContain(d)
        expect(out).not.toContain('big.py')
        expect(out).toContain('not opened: ')
        expect(out).toContain('venv')
      })

      it("never shows Sachivji's own .sachiv-handoff folder at any level", async () => {
        await mkdir(join(root, 'code', '.sachiv-handoff'), { recursive: true })
        await mkdir(join(root, '.sachiv-handoff', 't'), { recursive: true })
        expect(await listDirectoryTool.execute({ depth: 3 }, ctx)).not.toContain('.sachiv-handoff')
      })

      it('caps a very long listing at 200 entries and states how many more there are', async () => {
        await mkdir(join(root, 'many'), { recursive: true })
        for (let i = 0; i < 250; i++) await writeFile(join(root, 'many', `f${String(i).padStart(3, '0')}.dat`), 'x')
        const out = await listDirectoryTool.execute({ depth: 2 }, ctx)
        expect(out.split('\n').filter((l) => l.startsWith('file  many/')).length).toBeLessThan(250)
        expect(out).toMatch(/\(\d+ more entries not shown: list a subfolder, or use a smaller depth\)/)
      })

      it('fails loudly for a folder that does not exist, as depth 1 does, instead of calling it empty (review of 0.4.0)', async () => {
        await expect(listDirectoryTool.execute({ path: 'nope', depth: 2 }, ctx)).rejects.toThrow(/ENOENT/)
        await expect(listDirectoryTool.execute({ path: 'nope' }, ctx)).rejects.toThrow(/ENOENT/)
      })

      it('reports an empty directory, and a nested start path gives names relative to it', async () => {
        await mkdir(join(root, 'empty'))
        expect(await listDirectoryTool.execute({ path: 'empty', depth: 2 }, ctx)).toBe('(empty directory)')
        const out = await listDirectoryTool.execute({ path: 'code', depth: 2 }, ctx)
        expect(out.split('\n')).toEqual(['dir   lib', 'dir   lib/deep', 'file  lib/util.py', 'file  a.py'])
      })
    })
  })
})
