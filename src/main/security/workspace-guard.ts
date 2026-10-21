import { homedir } from 'node:os'
import { resolve, relative, isAbsolute } from 'node:path'

/** TASKS #235: the shell expands a leading `~` and models write it constantly, so the file tools do too. `~`, `~/x` and `~\x` only (not `~user`, not `~x`); done before every gate, so protected and outside-workspace rules apply to the expanded path. */
export function expandHome(target: string, home: string = homedir()): string {
  if (target === '~') return home
  if (target.startsWith('~/') || (process.platform === 'win32' && target.startsWith('~\\'))) return resolve(home, target.slice(2))
  return target
}

/**
 * Enforces the workspace-boundary requirement with real path checks, not a
 * setting the agent is merely asked to respect. Every file tool must route
 * its target path through `assertWithinWorkspace` before touching disk.
 *
 * The shell tool is different: an arbitrary command string can't be
 * validated as a single path argument (`cd ..`, an absolute path, etc. all
 * trivially escape a `cwd`-scoped process), so it only fixes the spawned
 * process's `cwd` to `root` — it is not sandboxed by this class, and human
 * confirmation (every shell/cloud-CLI call is `mutates: true`) is the real
 * safety gate for it, not path canonicalization.
 */
export class WorkspaceGuard {
  private readonly workspaceRoot: string

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot)
  }

  /** The resolved workspace root — e.g. as a subprocess `cwd` for the shell/cloud-CLI tools. */
  get root(): string {
    return this.workspaceRoot
  }

  assertWithinWorkspace(targetPath: string): string {
    const resolved = resolve(this.workspaceRoot, expandHome(targetPath))
    const rel = relative(this.workspaceRoot, resolved)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Path "${targetPath}" resolves outside the workspace boundary (${this.workspaceRoot})`)
    }
    return resolved
  }
}
