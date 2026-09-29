import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Tool } from './types'
import { EXCLUDED_FOLDERS, workspaceRelativePath } from './workspace-layout'

/**
 * TASKS.md #148: recursive find-by-pattern, the fix for the incident that
 * also produced #149 — 15 separate `list_directory` calls (some carrying an
 * undocumented, silently-ignored `depth` param) where one recursive pass
 * should have done the job. A real typed schema means an unsupported param
 * is a validation error the model can see, not a silently-flat listing.
 */

/** Directories never descended into, regardless of `.gitignore` — the usual noise plus this project's own
 * `EXCLUDED_FOLDERS` (workspace-layout.ts), reused rather than duplicated so the two lists can't drift apart. */
const DEFAULT_IGNORED_DIRS = new Set([
  ...EXCLUDED_FOLDERS,
  'node_modules',
  '.git',
  'venv',
  '.venv',
  '__pycache__',
  'dist',
  'out',
  'build',
  '.cache'
])

const MAX_ENTRIES_SCANNED = 20_000

/**
 * Converts a glob pattern (`**`, `*`, `?` only — not full glob syntax) into
 * a RegExp matched against a POSIX-style (forward-slash) relative path.
 * `**` matches across path separators (any depth, including zero), a bare
 * `*` matches within one path segment only, `?` matches one non-separator
 * character. Everything else is escaped literally.
 */
function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      out += '.*'
      i++
      if (pattern[i + 1] === '/') i++ // `**/` also matches zero directories
    } else if (c === '*') {
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

/**
 * A deliberately partial `.gitignore` reader — line-based directory/file
 * name and `*`/`?` glob patterns only, matched by basename at any depth
 * (the common case: `node_modules`, `*.log`) unless the pattern contains a
 * `/` (then it's matched against the path relative to the workspace root).
 * Does NOT support `!` negation or `**` inside a gitignore pattern — real
 * gitignore semantics have enough edge cases that getting this exactly
 * right would need a dedicated library; this covers the patterns that
 * actually show up in practice; anything more exotic is silently not
 * excluded (fails open, never hides a real file the user didn't ask to hide).
 */
async function readGitignorePatterns(workspaceRoot: string): Promise<RegExp[]> {
  try {
    const text = await readFile(join(workspaceRoot, '.gitignore'), 'utf-8')
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
      .map((line) => line.replace(/\/$/, '')) // directory-only trailing slash doesn't change basename matching here
      .map((line) => (line.includes('/') ? globToRegExp(line.replace(/^\//, '')) : globToRegExp(`**/${line}`)))
  } catch {
    return [] // no .gitignore, or unreadable — not an error, just nothing extra to exclude
  }
}

interface WalkResult {
  /** Relative to the SEARCH root (what the user's `pattern` matches against), not the workspace root. */
  files: string[]
  scanned: number
  truncated: boolean
}

/**
 * `relFromSearch` builds the path relative to the search root — what `pattern` matches against and what ends up
 * in `result.files`. `workspacePrefix` is the search root's own path relative to the workspace root (possibly
 * `''`, searching at the root) — carried separately only so `.gitignore` patterns, which are always relative to
 * the workspace root regardless of where the search started, can be checked against the right path.
 */
async function walk(
  absDir: string,
  relFromSearch: string,
  workspacePrefix: string,
  ignorePatterns: RegExp[],
  result: WalkResult
): Promise<void> {
  if (result.truncated) return
  let entries
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch {
    return // a broken symlink or a race with something deleting the dir mid-walk — skip, don't fail the whole search
  }
  for (const entry of entries) {
    if (result.scanned >= MAX_ENTRIES_SCANNED) {
      result.truncated = true
      return
    }
    result.scanned++
    const relPath = relFromSearch ? `${relFromSearch}/${entry.name}` : entry.name
    const workspaceRelPath = workspacePrefix ? `${workspacePrefix}/${relPath}` : relPath
    if (entry.isDirectory()) {
      if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue
      if (ignorePatterns.some((p) => p.test(workspaceRelPath) || p.test(entry.name))) continue
      await walk(join(absDir, entry.name), relPath, workspacePrefix, ignorePatterns, result)
    } else if (entry.isFile()) {
      if (ignorePatterns.some((p) => p.test(workspaceRelPath) || p.test(entry.name))) continue
      result.files.push(relPath)
    }
  }
}

export const findFilesTool: Tool = {
  name: 'find_files',
  description:
    'Recursively find files under a workspace path matching a glob pattern (e.g. "**/*.png", "code/*.py", ' +
    '"**/report*"). One call covers what would otherwise take many list_directory calls at different depths. ' +
    'Respects .gitignore (basic patterns only) plus the usual noise directories (node_modules, .git, venv, ' +
    'dist, ...), which are never descended into. Matches files only, not directories.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to search under, relative to the workspace root (default: root)' },
      pattern: {
        type: 'string',
        description: 'Glob pattern relative to `path` — ** for any depth, * within one segment, ? for one character (default: **/*, i.e. every file)'
      }
    }
  },
  mutates: false,
  async execute(input, ctx) {
    const searchPath = ctx.workspaceGuard.assertWithinWorkspace(String(input.path ?? '.'))
    const pattern = String(input.pattern ?? '**/*')
    const matcher = globToRegExp(pattern)
    const ignorePatterns = await readGitignorePatterns(ctx.workspaceGuard.root)

    const workspacePrefix = workspaceRelativePath(ctx.workspaceGuard.root, searchPath)
    const result: WalkResult = { files: [], scanned: 0, truncated: false }
    await walk(searchPath, '', workspacePrefix, ignorePatterns, result)

    // Matched against the search-root-relative path (what `pattern` describes), then re-prefixed to the
    // workspace root for display — the output must be directly usable as read_file/write_file's own `path` input.
    const matched = result.files
      .filter((relPath) => matcher.test(relPath))
      .map((relPath) => (workspacePrefix ? `${workspacePrefix}/${relPath}` : relPath))
      .sort()
    if (matched.length === 0) {
      return result.truncated
        ? `No files matched "${pattern}" (search stopped early after scanning ${MAX_ENTRIES_SCANNED} entries — narrow the path or pattern).`
        : `No files matched "${pattern}".`
    }
    const header = result.truncated
      ? `${matched.length} file(s) matched "${pattern}" (search stopped early after scanning ${MAX_ENTRIES_SCANNED} entries — results may be incomplete; narrow the path or pattern for a complete list):`
      : `${matched.length} file(s) matched "${pattern}":`
    return `${header}\n${matched.join('\n')}`
  }
}
