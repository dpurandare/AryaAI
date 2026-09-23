import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, relative } from 'node:path'
import type { Tool } from './types'
import { resolveNewFilePath } from './workspace-layout'

const MAX_READ_BYTES = 200_000

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read a UTF-8 text file inside the workspace and return its contents.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path relative to the workspace root' } },
    required: ['path']
  },
  mutates: false,
  async execute(input, ctx) {
    const path = ctx.workspaceGuard.assertWithinWorkspace(String(input.path ?? ''))
    const info = await stat(path)
    if (info.size > MAX_READ_BYTES) {
      throw new Error(`File is ${info.size} bytes, over the ${MAX_READ_BYTES}-byte read limit.`)
    }
    return readFile(path, 'utf-8')
  }
}

export const listDirectoryTool: Tool = {
  name: 'list_directory',
  description: 'List files and subdirectories at a path inside the workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root (default: root)' }
    }
  },
  mutates: false,
  async execute(input, ctx) {
    const path = ctx.workspaceGuard.assertWithinWorkspace(String(input.path ?? '.'))
    const entries = await readdir(path, { withFileTypes: true })
    if (entries.length === 0) return '(empty directory)'
    return entries
      .map((e) => `${e.isDirectory() ? 'dir ' : 'file'}  ${e.name}`)
      .sort()
      .join('\n')
  }
}

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Create or overwrite a UTF-8 text file inside the workspace. A brand-new file is placed ' +
    "automatically by kind — code (.py/.js/.ts/.sh/.sql/...) under code/, an office/document format " +
    "under documents/, an image/video/icon under resources/, anything else at the workspace root — " +
    'regardless of the path given; the result message states the real path actually used. Overwriting ' +
    'a file that already exists always writes back to wherever it already is, never relocates it.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root' },
      content: { type: 'string', description: 'Full file contents to write' }
    },
    required: ['path', 'content']
  },
  mutates: true,
  describe(input) {
    const content = String(input.content ?? '')
    return `Write ${content.length} characters to "${String(input.path ?? '')}"`
  },
  async execute(input, ctx) {
    const content = String(input.content ?? '')
    const path = resolveNewFilePath(ctx.workspaceGuard, String(input.path ?? ''))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf-8')
    return `Wrote ${content.length} characters to ${relative(ctx.workspaceGuard.root, path)}.`
  }
}
