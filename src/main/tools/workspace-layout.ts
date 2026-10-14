import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import type { WorkspaceGuard } from '../security/workspace-guard'

/**
 * Where a newly-created file of a given kind belongs, per explicit user
 * request (2026-09-23): code the agent generates in `code/`, office/document
 * output in `documents/`, images/video/icons in `resources/`, everything
 * else at the workspace root. Enforced here — in the tools that actually
 * create files — rather than only asked of the model in a prompt, matching
 * this app's own general approach to reliability (a model-followed
 * convention is a suggestion; a path computed in code is a guarantee).
 */
export type ManagedFolder = 'code' | 'documents' | 'resources'

export const MANAGED_FOLDERS: readonly ManagedFolder[] = ['code', 'documents', 'resources']

/**
 * Pre-existing, special-purpose folders that predate this convention and must
 * never be reclassified into a managed folder just because a file inside them
 * happens to have a matching extension: `templates/` holds user-authored
 * input templates that `office_fill_template` reads back by their literal
 * path, and `.sachiv-clones` (see `CLONES_DIR` in `tools/git.ts`) is
 * `git_clone_repo`'s fixed clone destination. Both stay exactly where they've
 * always been.
 */
/** Exported for reuse by find-files.ts (#148) — these predate the recursive-search tool but should be
 * excluded from it for the same reason they're excluded from write-placement: not ordinary managed content. */
export const EXCLUDED_FOLDERS: readonly string[] = ['templates', '.sachiv-clones']

const CODE_EXTENSIONS = new Set([
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'go', 'rb', 'php', 'rs', 'swift', 'kt', 'kts',
  'sql', 'r', 'pl', 'lua', 'scala', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'html', 'htm', 'css', 'scss'
])

const DOCUMENT_EXTENSIONS = new Set([
  'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'pdf', 'odt', 'ods', 'odp', 'rtf'
])

const RESOURCE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'tif',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'wav', 'ogg', 'flac', 'm4a'
])

/** `null` means "no managed folder for this extension" — stays at the workspace root, or wherever it already is. */
export function classifyManagedFolder(pathOrFilename: string): ManagedFolder | null {
  const ext = extname(pathOrFilename).slice(1).toLowerCase()
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'documents'
  if (RESOURCE_EXTENSIONS.has(ext)) return 'resources'
  return null
}

function isUnderFolder(workspaceRelativePath: string, folder: string): boolean {
  return workspaceRelativePath === folder || workspaceRelativePath.startsWith(folder + sep)
}

function isAlreadyUnderAManagedFolder(workspaceRelativePath: string): boolean {
  return MANAGED_FOLDERS.some((folder) => isUnderFolder(workspaceRelativePath, folder))
}

function isUnderAnExcludedFolder(workspaceRelativePath: string): boolean {
  return EXCLUDED_FOLDERS.some((folder) => isUnderFolder(workspaceRelativePath, folder))
}

/**
 * Resolves the real path to create a *new* file at, applying the
 * code/documents/resources convention — the one function every file-writing
 * tool should route a model-given path through instead of calling
 * `workspaceGuard.assertWithinWorkspace` directly.
 *
 * Deliberately never redirects a path that already resolves to an existing
 * file: `xlsx_write`'s append mode, `write_file` overwriting something that
 * already lives somewhere else, and any other "modify what's already there"
 * case must land on the file that's actually there, not silently create a
 * second copy in a different folder because of its extension. Reclassifying
 * only applies to genuine creation, and only when the given path doesn't
 * already explicitly target one of the managed folders (so an intentional
 * `code/scripts/foo.py`-style path from the model is never double-nested
 * into `code/code/scripts/foo.py`).
 */
export function resolveNewFilePath(workspaceGuard: WorkspaceGuard, relPath: string): string {
  const straightAbsPath = workspaceGuard.assertWithinWorkspace(relPath)
  if (existsSync(straightAbsPath)) return straightAbsPath

  const folder = classifyManagedFolder(relPath)
  if (!folder) return straightAbsPath

  const workspaceRelative = relative(workspaceGuard.root, straightAbsPath)
  // `tmp/` is where scripts and the agents are told to keep scratch files (SCRATCH_DIR), so a path there is an explicit choice.
  // Found live (8.2): `tmp/date_script.sh` was silently moved to `code/tmp/date_script.sh`, the run step looked in `tmp/`, and a
  // small model rewrote the same file in a loop.
  if (isAlreadyUnderAManagedFolder(workspaceRelative) || isUnderAnExcludedFolder(workspaceRelative) || isUnderFolder(workspaceRelative, SCRATCH_DIR)) {
    return straightAbsPath
  }

  return workspaceGuard.assertWithinWorkspace(join(folder, relPath))
}

/**
 * A path relative to the workspace root, always with forward slashes — what
 * tools report back to the model. The prompts and folder conventions all use
 * `/`, so on Windows a `documents\report.docx` result would be inconsistent
 * with them (and with `python_run`, which already reports `/`).
 */
export function workspaceRelativePath(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/')
}

/** Where scripts put scratch and intermediate files (page images, crops, temp data). Cleared automatically after a while — see `pruneScratchDir`. */
export const SCRATCH_DIR = 'tmp'

export interface MovedFile {
  from: string
  to: string
}

/**
 * Keeps the workspace root clean after a script run. Scripts run with the workspace root as their working directory,
 * so a bare `open('page_0.png', 'wb')` lands there — found live: one scanned-passport session left 120 loose images
 * in the root. Every NEW file a run left directly in the root is moved by the same convention file tools already use
 * (documents/, code/, resources/), and anything that fits none of them goes to `tmp/`. Files the script put in a
 * folder itself, hidden files and files that already existed are never touched. A name that is taken gets a numbered
 * suffix. Best-effort per file: a failed move leaves that file where it was.
 *
 * Only a BULK of loose files is tidied (`minCount`, default 4): one or two are normally the output the user asked
 * for ("save it as data.json"), which must stay exactly where the script put it — moving those, or deleting them
 * with the scratch folder later, would lose a deliverable. A run that scatters many files is scratch work.
 */
export const LOOSE_FILE_SWEEP_THRESHOLD = 4

export async function tidyRootStrays(root: string, created: readonly string[], minCount = LOOSE_FILE_SWEEP_THRESHOLD): Promise<MovedFile[]> {
  const moved: MovedFile[] = []
  const loose = created.filter((rel) => !rel.includes('/') && !rel.includes(sep) && !rel.startsWith('.'))
  if (loose.length < minCount) return moved
  for (const rel of loose) {
    const folder = classifyManagedFolder(rel) ?? SCRATCH_DIR
    try {
      await mkdir(join(root, folder), { recursive: true })
      const ext = extname(rel)
      const stem = basename(rel, ext)
      let target = `${folder}/${rel}`
      for (let n = 2; existsSync(join(root, target)); n++) target = `${folder}/${stem}-${n}${ext}`
      await rename(join(root, rel), join(root, target))
      moved.push({ from: rel, to: target })
    } catch {
      // leave it where it is
    }
  }
  return moved
}

/** Deletes files under `tmp/` not touched for `maxAgeMs`, then any folders left empty. Best-effort; never throws. */
export async function pruneScratchDir(root: string, maxAgeMs: number, now = Date.now()): Promise<void> {
  async function walk(dir: string): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      try {
        const info = await stat(full)
        if (info.isDirectory()) {
          await walk(full)
          await rmdir(full).catch(() => undefined) // only succeeds when empty
        } else if (now - info.mtimeMs > maxAgeMs) {
          await rm(full, { force: true })
        }
      } catch {
        // ignore
      }
    }
  }
  await walk(join(root, SCRATCH_DIR))
}
