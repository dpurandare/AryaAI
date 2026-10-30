import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'
import { expandHome } from './workspace-guard'
import { PROTECTED_ABSOLUTE, PROTECTED_UNDER_HOME } from '@shared/command-risk'

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

const BLOCKED_UNDER_HOME = PROTECTED_UNDER_HOME
const BLOCKED_ABSOLUTE = PROTECTED_ABSOLUTE

/** A `BLOCKED_ABSOLUTE` entry (e.g. `/etc`) has no drive letter — a cross-platform literal
 *  that was never meant to be Windows-specific. `abs`, in contrast, picked up a real drive
 *  letter from wherever it was resolved (the workspace root, `homedir()`, ...). On win32,
 *  `path.relative`/`path.resolve` fill in a MISSING drive from `process.cwd()`'s own drive —
 *  not from the other path being compared against — so a driveless pattern and a
 *  drive-qualified path can silently resolve onto different drives and never match, even
 *  when they're obviously "the same place" (confirmed live via Windows CI: `isBlocked('/etc/hosts')`
 *  returned false because the workspace root's temp dir and `/etc`'s implicit cwd-derived
 *  drive differed). Fix: strip `abs`'s drive letter before comparing against a driveless
 *  pattern, so both sides are driveless and `path.win32.relative` compares them directly. */
function isUnder(abs: string, folder: string): boolean {
  if (process.platform === 'win32' && win32.isAbsolute(folder) && !/^[A-Za-z]:/.test(folder)) {
    const driveless = abs.replace(/^[A-Za-z]:/, '')
    const rel = win32.relative(folder, driveless)
    return rel === '' || (!rel.startsWith('..') && !win32.isAbsolute(rel))
  }
  const rel = relative(folder, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export type GrantFolderCheck =
  | { ok: true; folder: string }
  | { ok: false; reason: 'not-a-folder' | 'blocked' | 'too-broad' | 'inside-workspace' | 'already-granted'; message: string; coveredBy?: string }

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

  /**
   * TASKS #216: may the user grant `chosen` up front (Settings > Add folder)? It becomes the same read-only "Always" grant a prompt would create,
   * so the protected list still wins at read time; this only keeps nonsense out of the list: a missing folder, a protected place, a place so broad
   * that granting it would expose the protected ones' neighbours (the home folder or anything above it, a drive or filesystem root), the
   * workspace itself, and a folder an earlier grant already covers.
   */
  checkGrantFolder(chosen: string, workspaceRoot: string): GrantFolderCheck {
    const abs = resolve(expandHome(chosen, this.home))
    if (!this.exists(abs) || !this.isDirectory(abs)) {
      return { ok: false, reason: 'not-a-folder', message: `"${chosen}" is not a folder that exists.` }
    }
    if (this.isBlocked(abs)) {
      return { ok: false, reason: 'blocked', message: `"${abs}" is a protected location (credentials, keys, system or Sachivji's own data) and can never be shared with the assistant.` }
    }
    const home = resolve(this.home)
    const containsProtected = [...BLOCKED_ABSOLUTE, ...BLOCKED_UNDER_HOME.map((b) => join(home, b))].find((b) => isUnder(b, abs))
    if (containsProtected) {
      return { ok: false, reason: 'too-broad', message: `"${abs}" is too broad: it contains a protected location (${containsProtected}). Choose a more specific folder inside it.` }
    }
    if (dirname(abs) === abs || isUnder(home, abs)) {
      return { ok: false, reason: 'too-broad', message: `"${abs}" is too broad: it contains your whole home folder. Choose a specific folder inside it, such as Documents or Downloads.` }
    }
    if (isUnder(abs, resolve(workspaceRoot))) {
      return { ok: false, reason: 'inside-workspace', message: `"${abs}" is inside the workspace, which the assistant can already use.` }
    }
    const covering = this.deps.getAlways().find((f) => isUnder(abs, f))
    if (covering) {
      return { ok: false, reason: 'already-granted', message: covering === abs ? `"${abs}" is already in the list.` : `"${abs}" is already covered by "${covering}".`, coveredBy: covering }
    }
    return { ok: true, folder: abs }
  }

  /** Validates and grants `chosen` for good; the outcome says which. */
  addAlways(chosen: string, workspaceRoot: string): GrantFolderCheck {
    const check = this.checkGrantFolder(chosen, workspaceRoot)
    if (check.ok) this.deps.setAlways([...this.deps.getAlways(), check.folder])
    return check
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
  const abs = resolve(ctx.workspaceGuard.root, expandHome(target))
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

