import { open, readFile, stat } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { isInsideWorkspace, resolveReadable } from '../security/external-access'
import { MAX_ENTRIES_SCANNED, globToRegExp, readGitignorePatterns, walk, type WalkResult } from './find-files'
import type { Tool } from './types'
import { workspaceRelativePath } from './workspace-layout'

/**
 * TASKS #169: search INSIDE files (what `grep -r` does), through the same workspace/outside-folder gate as every file tool and without
 * needing a `grep` on the machine (Windows has none). Built to return something the model can use whole: a cap on matches per file and on
 * files shown, each stated honestly in the result ("N more not shown, narrow the search"), never a silent cut.
 */

/** Files that are not text: searching their bytes would be slow and the matches meaningless. */
const BINARY_EXTENSIONS = new Set([
  'docx', 'doc', 'dotx', 'xlsx', 'xlsm', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'pdf',
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tiff', 'tif', 'svgz',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'whl',
  'mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'mov', 'avi', 'mkv', 'webm',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'pyc', 'woff', 'woff2', 'ttf', 'otf', 'sqlite', 'db', 'parquet'
])

const MAX_FILE_BYTES = 1_000_000
const SNIFF_BYTES = 4096
const MAX_PATTERN_CHARS = 500
/** A pathological minified line could make a regex slow; longer lines are matched on their first part only. */
const MAX_TESTED_LINE_CHARS = 5_000
const MAX_SHOWN_LINE_CHARS = 240

/** Fixed on purpose: the model rarely needs to change them, and every schema word is paid for on every request (prompt-budget.test.ts). */
const DEFAULT_MAX_FILES = 30
const DEFAULT_MATCHES_PER_FILE = 5
const HARD_CONTEXT = 3

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback
}

function shown(line: string): string {
  const text = line.length > MAX_SHOWN_LINE_CHARS ? `${line.slice(0, MAX_SHOWN_LINE_CHARS)}…` : line
  return text.replace(/\s+$/, '')
}

function buildMatcher(pattern: string, isRegex: boolean, caseSensitive: boolean): RegExp {
  const source = isRegex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(source, caseSensitive ? '' : 'i')
}

interface FileHits {
  path: string
  /** Rendered lines for the matches shown (with context), in order. */
  lines: string[]
  total: number
  shownCount: number
}

async function isProbablyText(abs: string): Promise<boolean> {
  const handle = await open(abs, 'r')
  try {
    const buf = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0)
    return !buf.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

function searchText(text: string, matcher: RegExp, context: number, perFile: number): { lines: string[]; total: number; shownCount: number } {
  const all = text.split(/\r?\n/)
  const out: string[] = []
  let total = 0
  let shownCount = 0
  let lastPrinted = -1
  for (let i = 0; i < all.length; i++) {
    const line = all[i].length > MAX_TESTED_LINE_CHARS ? all[i].slice(0, MAX_TESTED_LINE_CHARS) : all[i]
    if (!matcher.test(line)) continue
    total++
    if (shownCount >= perFile) continue
    shownCount++
    const from = Math.max(lastPrinted + 1, i - context)
    if (context > 0 && lastPrinted >= 0 && from > lastPrinted + 1) out.push('  --')
    for (let j = from; j < i; j++) out.push(`  ${j + 1}- ${shown(all[j])}`)
    out.push(`  ${i + 1}: ${shown(all[i])}`)
    const after = Math.min(all.length - 1, i + context)
    for (let j = i + 1; j <= after; j++) {
      // a later match inside the trailing context prints as a match when its turn comes
      if (matcher.test(all[j].length > MAX_TESTED_LINE_CHARS ? all[j].slice(0, MAX_TESTED_LINE_CHARS) : all[j])) break
      out.push(`  ${j + 1}- ${shown(all[j])}`)
      lastPrinted = j
    }
    lastPrinted = Math.max(lastPrinted, i)
  }
  return { lines: out, total, shownCount }
}

export const findInFilesTool: Tool = {
  name: 'find_in_files',
  description:
    'Search the text inside files (like grep -r), in the workspace or an allowed folder. Literal and case-insensitive by default. ' +
    'Skips binary and large files, .gitignore entries, node_modules/.git/venv. Shows file:line matches; says how many more are not shown. ' +
    'To find files by name use find_files.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text to find (a regular expression if regex is true)' },
      path: { type: 'string', description: 'Folder to search under (default: workspace root)' },
      glob: { type: 'string', description: 'Only files matching this glob, e.g. **/*.py' },
      regex: { type: 'boolean', description: 'Pattern is a regular expression' },
      case_sensitive: { type: 'boolean' },
      context: { type: 'number', description: `Lines around each match, 0-${HARD_CONTEXT}` }
    },
    required: ['pattern']
  },
  mutates: false,
  externalPaths: (input) => [{ path: String(input.path ?? '.'), access: 'read' }],
  async execute(input, ctx) {
    const pattern = String(input.pattern ?? '')
    if (!pattern) throw new Error('pattern is required: the text (or regular expression) to look for.')
    if (pattern.length > MAX_PATTERN_CHARS) throw new Error(`pattern is too long (over ${MAX_PATTERN_CHARS} characters); search for a shorter piece.`)
    let matcher: RegExp
    try {
      matcher = buildMatcher(pattern, input.regex === true, input.case_sensitive === true)
    } catch (err) {
      throw new Error(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`)
    }
    const context = clampInt(input.context, 0, 0, HARD_CONTEXT)
    const perFile = DEFAULT_MATCHES_PER_FILE
    const maxFiles = DEFAULT_MAX_FILES

    const searchPath = resolveReadable(ctx, String(input.path ?? '.'))
    const outside = !isInsideWorkspace(ctx, String(input.path ?? '.'))
    const fileGlob = globToRegExp(String(input.glob ?? '**/*'))
    const ignorePatterns = outside ? [] : await readGitignorePatterns(ctx.workspaceGuard.root)
    const workspacePrefix = outside ? searchPath.split(sep).join('/') : workspaceRelativePath(ctx.workspaceGuard.root, searchPath)

    const listing: WalkResult = { files: [], scanned: 0, truncated: false }
    await walk(searchPath, '', workspacePrefix, ignorePatterns, listing)
    const candidates = listing.files.filter((rel) => fileGlob.test(rel)).sort()

    const hits: FileHits[] = []
    let searched = 0
    let skippedBinary = 0
    let skippedLarge = 0
    let unreadable = 0
    let stoppedAtFileCap = false
    let totalMatches = 0
    for (const rel of candidates) {
      if (hits.length >= maxFiles) {
        stoppedAtFileCap = true
        break
      }
      if (BINARY_EXTENSIONS.has(extname(rel).slice(1).toLowerCase())) {
        skippedBinary++
        continue
      }
      const abs = join(searchPath, rel)
      try {
        const info = await stat(abs)
        if (info.size > MAX_FILE_BYTES) {
          skippedLarge++
          continue
        }
        if (!(await isProbablyText(abs))) {
          skippedBinary++
          continue
        }
        const found = searchText(await readFile(abs, 'utf-8'), matcher, context, perFile)
        searched++
        if (found.total === 0) continue
        totalMatches += found.total
        hits.push({ path: workspacePrefix ? `${workspacePrefix}/${rel}` : rel, ...found })
      } catch {
        unreadable++
      }
    }

    const notes: string[] = []
    if (skippedBinary) notes.push(`${skippedBinary} binary file(s) skipped`)
    if (skippedLarge) notes.push(`${skippedLarge} file(s) over 1 MB skipped`)
    if (unreadable) notes.push(`${unreadable} unreadable`)
    const scope = `searched ${searched} file(s)${notes.length ? `; ${notes.join(', ')}` : ''}`
    if (hits.length === 0) {
      const early = listing.truncated ? ` The folder scan stopped early after ${MAX_ENTRIES_SCANNED} entries; narrow the path or glob.` : ''
      return `No matches for "${pattern}" (${scope}).${early}`
    }
    const body = hits
      .map((h) => {
        const more = h.total > h.shownCount ? ` (${h.total - h.shownCount} more match(es) in this file not shown)` : ''
        return `${h.path}${more}\n${h.lines.join('\n')}`
      })
      .join('\n')
    const caps: string[] = []
    if (stoppedAtFileCap) caps.push(`stopped after ${maxFiles} files with matches; more files may match`)
    if (listing.truncated) caps.push(`the folder scan stopped early after ${MAX_ENTRIES_SCANNED} entries`)
    const tail = caps.length ? `\n(${caps.join('; ')} — narrow the path, glob or pattern for the rest.)` : ''
    return `${totalMatches} match(es) in ${hits.length} file(s) for "${pattern}" (${scope}):\n${body}${tail}`
  }
}
