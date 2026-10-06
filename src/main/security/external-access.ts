import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Access to files OUTSIDE the workspace, which the file tools used to refuse outright: a file the user downloaded
 * into Downloads or keeps in Documents could only be reached by copying it into the workspace by hand (or through
 * the unchecked shell, by accident of which tool the model happened to pick).
 *
 * The rules, as the user set them:
 *  - READ is allowed per folder, after asking: just once, for this session, or always (listed in Settings, where it
 *    can be revoked). A grant covers that folder and everything below it.
 *  - WRITE outside is limited to creating a NEW file, confirmed each time, never remembered.
 *  - Editing or deleting an existing outside file is never offered by these tools. (The shell and Python are not
 *    sandboxed and can still do anything the user can; the confirmation they already need is their only guard.)
 *  - Some places are never reachable, whatever the user clicks: credentials, keys, the keychain, the app's own data.
 */
export const EXTERNAL_ACCESS_TOOL_NAME = 'external_folder_access'
export const EXTERNAL_READ_FOLDERS_SETTING_KEY = 'externalReadFolders'

export type ExternalAccessKind = 'read' | 'write-new'
export type RememberScope = 'once' | 'session' | 'always'

/** Home-relative places that are never offered, even if a parent folder was granted. */
const BLOCKED_UNDER_HOME = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.azure',
  '.kube',
  '.docker',
  '.config/gcloud',
  '.sachivji',
  'Library/Keychains',
  'Library/Cookies',
  'Library/Application Support/Sachivji',
  'Library/Application Support/Sachiv'
]
const BLOCKED_ABSOLUTE = ['/etc', '/private/etc', '/var/db', '/System', '/Library/Keychains']

function isUnder(abs: string, folder: string): boolean {
  const rel = relative(folder, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export interface ExternalAccessDeps {
  getAlways(): string[]
  setAlways(folders: string[]): void
  /** Overridable for tests. */
  home?: string
  exists?: (path: string) => boolean
  isDirectory?: (path: string) => boolean
}

export class ExternalAccess {
  private readonly sessionGrants = new Map<string, Set<string>>()
  private readonly onceGrants = new Map<string, number>()
  private readonly home: string
  private readonly exists: (path: string) => boolean
  private readonly isDirectory: (path: string) => boolean

  constructor(private readonly deps: ExternalAccessDeps) {
    this.home = deps.home ?? homedir()
    this.exists = deps.exists ?? existsSync
    this.isDirectory = deps.isDirectory ?? ((p) => { try { return statSync(p).isDirectory() } catch { return false } })
  }

  /** Never reachable: credentials, keys, the keychain, system config and Sachivji's own data. */
  isBlocked(abs: string): boolean {
    return (
      BLOCKED_ABSOLUTE.some((b) => isUnder(abs, b)) || BLOCKED_UNDER_HOME.some((b) => isUnder(abs, join(this.home, b)))
    )
  }

  /** The folder a request is about: a directory itself, otherwise the folder holding the file. */
  folderFor(abs: string): string {
    return this.exists(abs) && this.isDirectory(abs) ? abs : dirname(abs)
  }

  isReadAllowed(sessionId: string, abs: string): boolean {
    if (this.isBlocked(abs)) return false
    const folders = [...this.deps.getAlways(), ...(this.sessionGrants.get(sessionId) ?? [])]
    return folders.some((f) => isUnder(abs, f)) || [...this.onceGrants.keys()].some((f) => isUnder(abs, f))
  }

  /** Creating a new file outside needs a fresh, call-scoped grant every time. */
  isWriteNewAllowed(abs: string): boolean {
    return !this.isBlocked(abs) && [...this.onceGrants.keys()].some((f) => isUnder(abs, f))
  }

  grant(sessionId: string, folder: string, scope: RememberScope): void {
    if (scope === 'always') {
      const list = this.deps.getAlways()
      if (!list.includes(folder)) this.deps.setAlways([...list, folder])
    } else if (scope === 'session') {
      const set = this.sessionGrants.get(sessionId) ?? new Set<string>()
      set.add(folder)
      this.sessionGrants.set(sessionId, set)
    }
  }

  /** Allows `folder` for the duration of one tool call; call the returned function when the call is over. */
  grantOnce(folder: string): () => void {
    this.onceGrants.set(folder, (this.onceGrants.get(folder) ?? 0) + 1)
    return () => {
      const n = (this.onceGrants.get(folder) ?? 1) - 1
      if (n <= 0) this.onceGrants.delete(folder)
      else this.onceGrants.set(folder, n)
    }
  }

  listAlways(): string[] {
    return this.deps.getAlways()
  }

  revokeAlways(folder: string): void {
    this.deps.setAlways(this.deps.getAlways().filter((f) => f !== folder))
  }
}

export interface ExternalAccessCtx {
  workspaceGuard: { root: string }
  currentSessionId: string
  externalAccess?: ExternalAccess
}

function resolveInWorkspaceOrNull(ctx: ExternalAccessCtx, target: string): { abs: string; inside: boolean } {
  const abs = resolve(ctx.workspaceGuard.root, target)
  const rel = relative(ctx.workspaceGuard.root, abs)
  return { abs, inside: !(rel.startsWith('..') || isAbsolute(rel)) }
}

/** The absolute path of a file or folder to READ: inside the workspace, or in a folder the user has allowed. Throws a message the model can act on. */
export function resolveReadable(ctx: ExternalAccessCtx, target: string): string {
  const { abs, inside } = resolveInWorkspaceOrNull(ctx, target)
  if (inside) return abs
  const access = ctx.externalAccess
  if (access?.isBlocked(abs)) {
    throw new Error(`"${target}" is a protected location (credentials, keys, system or Sachivji's own data) and cannot be read.`)
  }
  if (access?.isReadAllowed(ctx.currentSessionId, abs)) return abs
  throw new Error(`"${target}" is outside the workspace and Sachivji has not been given access to that folder. The user is asked before a folder is read — call the tool again, or ask the user to allow it.`)
}

/** The absolute path of a NEW file to create outside the workspace: allowed only for this call, only if it does not exist yet and its folder does. */
export function resolveWritableNewOutside(ctx: ExternalAccessCtx, target: string): string {
  const { abs } = resolveInWorkspaceOrNull(ctx, target)
  const access = ctx.externalAccess
  if (access?.isBlocked(abs)) throw new Error(`"${target}" is a protected location and cannot be written.`)
  if (!access?.isWriteNewAllowed(abs)) throw new Error(`"${target}" is outside the workspace; saving there needs the user's confirmation for that file.`)
  if (existsSync(abs)) throw new Error(`"${target}" already exists. Sachivji never overwrites or edits a file outside the workspace — choose a new name.`)
  if (!existsSync(dirname(abs))) throw new Error(`The folder "${dirname(abs)}" does not exist; Sachivji does not create folders outside the workspace.`)
  return abs
}

export function isInsideWorkspace(ctx: ExternalAccessCtx, target: string): boolean {
  return resolveInWorkspaceOrNull(ctx, target).inside
}

