import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * Before/after snapshots of the workspace, used to find the files a piece of work really
 * created or changed — derived from the filesystem, never from what a model says it did.
 * Shared by the typed handoff between specialists (agents/handoff.ts) and by `python_run`
 * (tools/python-run.ts), so both report artifacts the same way.
 */

/** Never scanned: dependencies, VCS data, the venv, our own bookkeeping. */
const IGNORED_DIRS = new Set(['venv', '.venv', 'node_modules', '.git', '__pycache__', '.pytest_cache', '.sachiv-clones', '.sachiv-handoff'])

export interface WorkspaceSnapshot {
  /** relative path -> "mtimeMs:size" */
  files: Map<string, string>
  /** The scan hit its entry cap, so a diff of this snapshot cannot be trusted to be complete. */
  truncated: boolean
}

export async function snapshotWorkspace(root: string, opts: { maxEntries?: number; maxDepth?: number } = {}): Promise<WorkspaceSnapshot> {
  const maxEntries = opts.maxEntries ?? 20_000
  const maxDepth = opts.maxDepth ?? 8
  const files = new Map<string, string>()
  let truncated = false

  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (truncated) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (truncated) return
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || depth >= maxDepth) continue
        await walk(path.join(dir, e.name), childRel, depth + 1)
      } else if (e.isFile()) {
        if (files.size >= maxEntries) {
          truncated = true
          return
        }
        try {
          const s = await stat(path.join(dir, e.name))
          files.set(childRel, `${Math.round(s.mtimeMs)}:${s.size}`)
        } catch {
          // vanished between readdir and stat — ignore
        }
      }
    }
  }

  await walk(root, '', 0)
  return { files, truncated }
}

export interface SnapshotDiff {
  created: string[]
  modified: string[]
  /** False when either snapshot was truncated: the lists may be incomplete. */
  reliable: boolean
}

export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): SnapshotDiff {
  const created: string[] = []
  const modified: string[] = []
  for (const [p, sig] of after.files) {
    const old = before.files.get(p)
    if (old === undefined) created.push(p)
    else if (old !== sig) modified.push(p)
  }
  return { created: created.sort(), modified: modified.sort(), reliable: !before.truncated && !after.truncated }
}
