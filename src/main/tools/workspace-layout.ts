import { existsSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
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

const MANAGED_FOLDERS: readonly ManagedFolder[] = ['code', 'documents', 'resources']

/**
 * Pre-existing, special-purpose folders that predate this convention and must
 * never be reclassified into a managed folder just because a file inside them
 * happens to have a matching extension: `templates/` holds user-authored
 * input templates that `office_fill_template` reads back by their literal
 * path, and `.sachiv-clones` (see `CLONES_DIR` in `tools/git.ts`) is
 * `git_clone_repo`'s fixed clone destination. Both stay exactly where they've
 * always been.
 */
const EXCLUDED_FOLDERS: readonly string[] = ['templates', '.sachiv-clones']

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
  if (isAlreadyUnderAManagedFolder(workspaceRelative) || isUnderAnExcludedFolder(workspaceRelative)) {
    return straightAbsPath
  }

  return workspaceGuard.assertWithinWorkspace(join(folder, relPath))
}
