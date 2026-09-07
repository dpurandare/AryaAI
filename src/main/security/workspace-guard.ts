import { resolve, relative, isAbsolute } from 'node:path'

/**
 * Enforces the workspace-boundary requirement with real path checks, not a
 * setting the agent is merely asked to respect. Every file/shell tool must
 * route its target path through `assertWithinWorkspace` before touching disk.
 */
export class WorkspaceGuard {
  private readonly root: string

  constructor(workspaceRoot: string) {
    this.root = resolve(workspaceRoot)
  }

  assertWithinWorkspace(targetPath: string): string {
    const resolved = resolve(this.root, targetPath)
    const rel = relative(this.root, resolved)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Path "${targetPath}" resolves outside the workspace boundary (${this.root})`)
    }
    return resolved
  }
}
