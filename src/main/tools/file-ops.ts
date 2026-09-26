import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import type { Tool } from './types'
import { resolveNewFilePath, workspaceRelativePath } from './workspace-layout'

const MAX_READ_BYTES = 200_000

const OFFICE_HINT = 'use office_create_document to make a Word document, or office_fill_template to fill a template'
const SCRIPT_HINT = 'generate it by writing a script and running it with shell_execute (e.g. matplotlib for a chart image)'

/**
 * Formats `write_file` must never write: it writes UTF-8 *text*, so any of
 * these ends up as garbage that looks like the real thing. Found live (the
 * Northwind bar-chart session): after `office_create_document` made a real
 * .docx, `write_file` overwrote the same path with 174 characters of markdown
 * — the deliverable was silently corrupted. Refusing here (with the right
 * tool named) is a code-level guard, not a prompt instruction.
 */
const BINARY_FORMAT_HINTS: Record<string, string> = {
  '.docx': OFFICE_HINT,
  '.doc': OFFICE_HINT,
  '.dotx': OFFICE_HINT,
  '.xlsx': 'use xlsx_write to create or edit a spreadsheet',
  '.xlsm': 'use xlsx_write to create or edit a spreadsheet',
  '.xls': 'use xlsx_write to create or edit a spreadsheet',
  '.pptx': 'use the pptx_start_deck / pptx_add_slide / pptx_save_deck tools to build a presentation',
  '.ppt': 'use the pptx_start_deck / pptx_add_slide / pptx_save_deck tools to build a presentation',
  '.pdf': SCRIPT_HINT,
  '.odt': SCRIPT_HINT,
  '.ods': SCRIPT_HINT,
  '.odp': SCRIPT_HINT,
  '.png': SCRIPT_HINT,
  '.jpg': SCRIPT_HINT,
  '.jpeg': SCRIPT_HINT,
  '.gif': SCRIPT_HINT,
  '.bmp': SCRIPT_HINT,
  '.webp': SCRIPT_HINT,
  '.ico': SCRIPT_HINT,
  '.tiff': SCRIPT_HINT,
  '.zip': SCRIPT_HINT,
  '.gz': SCRIPT_HINT
}

function assertTextWritable(requestedPath: string): void {
  const ext = extname(requestedPath).toLowerCase()
  const hint = BINARY_FORMAT_HINTS[ext]
  if (hint) {
    throw new Error(
      `write_file writes UTF-8 text only, so it would corrupt a ${ext} file — nothing was written. Instead: ${hint}.`
    )
  }
}

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
    'a file that already exists always writes back to wherever it already is, never relocates it. ' +
    'Text only: it refuses binary formats (.docx/.xlsx/.pptx/.pdf/images/archives) — use the office_*, ' +
    'xlsx_write or pptx_* tools, or a script run via shell_execute.',
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
    assertTextWritable(String(input.path ?? ''))
    const path = resolveNewFilePath(ctx.workspaceGuard, String(input.path ?? ''))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf-8')
    return `Wrote ${content.length} characters to ${workspaceRelativePath(ctx.workspaceGuard.root, path)}.`
  }
}
