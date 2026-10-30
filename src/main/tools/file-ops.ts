import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { isInsideWorkspace, resolveReadable, resolveWritableNewOutside } from '../security/external-access'
import type { Tool } from './types'
import { INTERNAL_FOLDER, resolveNewFilePath, workspaceRelativePath } from './workspace-layout'

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
  description: 'Read a UTF-8 text file and return its contents. Inside the workspace, or an absolute path elsewhere (the user is asked first; read only).',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path relative to the workspace root, or an absolute path' } },
    required: ['path']
  },
  mutates: false,
  externalPaths: (input) => [{ path: String(input.path ?? ''), access: 'read' }],
  async execute(input, ctx) {
    const path = resolveReadable(ctx, String(input.path ?? ''))
    const info = await stat(path)
    if (info.size > MAX_READ_BYTES) {
      throw new Error(`File is ${info.size} bytes, over the ${MAX_READ_BYTES}-byte read limit.`)
    }
    return readFile(path, 'utf-8')
  }
}

/** TASKS #238: `list_directory` with a depth. */
const MAX_LIST_DEPTH = 3
const MAX_LIST_ENTRIES = 200
/** Shown as entries but not opened when listing several levels: dependency and build noise, scratch space and Sachivji's own clones. */
const NOT_EXPANDED = new Set(['node_modules', '.git', 'venv', '.venv', '__pycache__', 'dist', 'out', 'build', '.cache', 'tmp', '.sachiv-clones'])

/**
 * A multi-level listing in the same one-entry-per-line form as the single level (`dir  name` / `file  name`), the names relative to the
 * listed folder with `/`, each folder followed by what is in it (folders first, then files, at every level). Capped, and the cap and the
 * folders left closed are stated, so a short listing is never mistaken for a complete one.
 */
async function listTree(root: string, depth: number, skipDir?: (absDir: string) => boolean): Promise<string> {
  const lines: string[] = []
  const closed: string[] = []
  let total = 0
  async function visit(dir: string, rel: string, level: number): Promise<void> {
    let entries
    try {
      entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.name !== INTERNAL_FOLDER && !(e.isDirectory() && skipDir?.(join(dir, e.name))))
    } catch (err) {
      // The listed folder itself must fail loudly (a missing or unreadable folder is not an empty one); a subfolder that cannot be read is just skipped.
      if (level === 1) throw err
      return
    }
    const sorted = [...entries].sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of sorted) {
      const name = rel ? `${rel}/${e.name}` : e.name
      total++
      if (lines.length < MAX_LIST_ENTRIES) lines.push(`${e.isDirectory() ? 'dir ' : 'file'}  ${name}`)
      if (!e.isDirectory()) continue
      if (NOT_EXPANDED.has(e.name)) closed.push(name)
      else if (level < depth) await visit(join(dir, e.name), name, level + 1)
    }
  }
  await visit(root, '', 1)
  if (total === 0) return '(empty directory)'
  const notes: string[] = []
  if (total > lines.length) notes.push(`${total - lines.length} more entries not shown: list a subfolder, or use a smaller depth`)
  if (closed.length > 0) notes.push(`not opened: ${closed.join(', ')} (list one directly if needed)`)
  return notes.length > 0 ? `${lines.join('\n')}\n(${notes.join('; ')})` : lines.join('\n')
}

export const listDirectoryTool: Tool = {
  name: 'list_directory',
  description: 'List files and subdirectories at a path in the workspace, or an absolute folder elsewhere (the user is asked first).',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative to the workspace root, or absolute (default: root)' },
      depth: { type: 'number', description: 'Levels, 1-3 (default 1); 2-3 for an overview' }
    }
  },
  mutates: false,
  externalPaths: (input) => [{ path: String(input.path ?? '.'), access: 'read' }],
  async execute(input, ctx) {
    const path = resolveReadable(ctx, String(input.path ?? '.'))
    const depth = Math.min(MAX_LIST_DEPTH, Math.max(1, Math.trunc(Number(input.depth ?? 1)) || 1))
    if (depth > 1) return listTree(path, depth, isInsideWorkspace(ctx, String(input.path ?? '.')) ? undefined : (dir) => ctx.externalAccess?.isBlocked(dir) ?? false)
    const entries = (await readdir(path, { withFileTypes: true })).filter((e) => e.name !== INTERNAL_FOLDER)
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
    'Create or overwrite a UTF-8 text file inside the workspace (an absolute path elsewhere may only create a NEW file, confirmed). A brand-new file is placed ' +
    "automatically by kind — code (.py/.js/.ts/.sh/.sql/...) under code/, an office/document format " +
    "or a bare .md/.txt name under documents/, an image/video/icon under resources/, a bare .csv/.json name under data/, anything else at the root — " +
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
  externalPaths: (input) => [{ path: String(input.path ?? ''), access: 'write-new' }],
  describe(input) {
    const content = String(input.content ?? '')
    return `Write ${content.length} characters to "${String(input.path ?? '')}"`
  },
  async execute(input, ctx) {
    const content = String(input.content ?? '')
    assertTextWritable(String(input.path ?? ''))
    if (!isInsideWorkspace(ctx, String(input.path ?? ''))) {
      // Outside the workspace only a brand-new file in an existing folder is ever written (never an overwrite).
      const outside = resolveWritableNewOutside(ctx, String(input.path ?? ''))
      await writeFile(outside, content, { encoding: 'utf-8', flag: 'wx' })
      return `Wrote ${content.length} characters to the new file ${outside} (outside the workspace).`
    }
    const path = resolveNewFilePath(ctx.workspaceGuard, String(input.path ?? ''))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf-8')
    const saved = workspaceRelativePath(ctx.workspaceGuard.root, path)
    const asked = String(input.path ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
    // A new file of a known type is filed under code/, documents/, resources/ or data/. Say so in words a model acts on: a bare
    // "Wrote … to code/x.sh" was ignored and the next step ran the path it had asked for.
    const moved = asked && saved !== asked ? ` New files of this type are filed under ${saved.split('/')[0]}/ — use "${saved}" (not "${asked}") for every later step, such as running or reading it.` : ''
    return `Wrote ${content.length} characters to ${saved}.${moved}`
  }
}
