import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { ROLE_MANIFEST, type RoleMeta } from '@shared/agents'
import { ROLE_FILE_LIMITS, validateRoleFile, type RoleFile } from '@shared/role-file'

/**
 * Loads user-defined roles from a folder (design-discussion.md 11.3–11.4): one `*.md` file per role. Loaded **per run** (a directory read plus
 * a modification-time check per file — cheap next to an LLM call), so an edit applies to the next message with no restart.
 *
 * Trust model (11.5): a role the user wrote or placed in this folder is the user's own configuration, like a CLAUDE.md, and loads enabled.
 * There is deliberately no import / share path — anything arriving that way would need to load disabled until reviewed. A role can only
 * select existing tools and shape a prompt; confirmation and the workspace guard are enforced per tool.
 */

export interface RoleProblem {
  /** File name within the roles folder. */
  file: string
  level: 'error' | 'warning'
  message: string
}

export interface LoadedRole {
  file: RoleFile
  /** File name within the roles folder. */
  sourceFile: string
  /** Quality warnings from the validator (the role still loads). */
  warnings: string[]
  /** False when the user switched it off in Settings. */
  enabled: boolean
  /** True when this is the previous working version, kept because the latest edit of the file has errors. */
  stale: boolean
}

export interface LoadResult {
  roles: LoadedRole[]
  problems: RoleProblem[]
}

/** Files starting with `_` or `.` are ignored, so an example or a draft can sit in the folder without loading. */
export function isRoleFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.md') && !name.startsWith('_') && !name.startsWith('.')
}

interface Cached {
  mtimeMs: number
  size: number
  text: string
}

export class UserRoleLoader {
  private readonly texts = new Map<string, Cached>()
  private readonly lastGood = new Map<string, RoleFile>()

  constructor(private readonly folder: () => string) {}

  async load(opts: { disabledIds?: ReadonlySet<string> } = {}): Promise<LoadResult> {
    const dir = this.folder()
    const problems: RoleProblem[] = []
    let names: string[]
    try {
      names = (await readdir(dir)).filter(isRoleFileName).sort((a, b) => a.localeCompare(b))
    } catch {
      this.texts.clear()
      this.lastGood.clear()
      return { roles: [], problems }
    }
    for (const gone of [...this.texts.keys()].filter((n) => !names.includes(n))) {
      this.texts.delete(gone)
      this.lastGood.delete(gone)
    }
    if (names.length > ROLE_FILE_LIMITS.roles) {
      for (const extra of names.slice(ROLE_FILE_LIMITS.roles)) problems.push({ file: extra, level: 'error', message: `Not loaded: only the first ${ROLE_FILE_LIMITS.roles} role files are used (every role's summary reaches the router on every turn).` })
      names = names.slice(0, ROLE_FILE_LIMITS.roles)
    }

    const roles: LoadedRole[] = []
    const siblings: RoleMeta[] = [...ROLE_MANIFEST]
    const takenIds = new Set<string>()
    for (const name of names) {
      const text = await this.read(dir, name, problems)
      if (text === undefined) {
        const keep = this.lastGood.get(name)
        if (keep && !takenIds.has(keep.id)) this.push(roles, siblings, takenIds, name, keep, [], opts, true)
        continue
      }
      const result = validateRoleFile(text, { takenIds, siblings })
      for (const i of result.issues.filter((x) => x.level === 'error')) problems.push({ file: name, level: 'error', message: i.message })
      if (!result.role) {
        // Keep the last working version of this file, if there was one, so a typo mid-edit does not silently remove the role.
        const keep = this.lastGood.get(name)
        if (keep && !takenIds.has(keep.id)) {
          problems.push({ file: name, level: 'warning', message: `Using the last working version of "${keep.id}" until these errors are fixed.` })
          this.push(roles, siblings, takenIds, name, keep, [], opts, true)
        }
        continue
      }
      this.lastGood.set(name, result.role)
      this.push(roles, siblings, takenIds, name, result.role, result.issues.filter((i) => i.level === 'warning').map((i) => i.message), opts, false)
    }
    return { roles, problems }
  }

  private push(roles: LoadedRole[], siblings: RoleMeta[], takenIds: Set<string>, sourceFile: string, file: RoleFile, warnings: string[], opts: { disabledIds?: ReadonlySet<string> }, stale: boolean): void {
    takenIds.add(file.id)
    siblings.push({ id: file.id, label: file.name, summary: file.summary, description: file.description, pickable: file.pickable, plannable: file.plannable, examples: file.examples, notExamples: file.notExamples })
    roles.push({ file, sourceFile, warnings, enabled: !opts.disabledIds?.has(file.id), stale })
  }

  /** The file's text, re-read only when its size or modification time changed. `undefined` when it cannot be used (unreadable, too big). */
  private async read(dir: string, name: string, problems: RoleProblem[]): Promise<string | undefined> {
    const full = path.join(dir, name)
    try {
      const s = await stat(full)
      if (!s.isFile()) return undefined
      if (s.size > ROLE_FILE_LIMITS.fileBytes) {
        problems.push({ file: name, level: 'error', message: `The file is ${s.size} bytes; the limit is ${ROLE_FILE_LIMITS.fileBytes}.` })
        return undefined
      }
      const cached = this.texts.get(name)
      if (cached && cached.mtimeMs === s.mtimeMs && cached.size === s.size) return cached.text
      const text = await readFile(full, 'utf-8')
      this.texts.set(name, { mtimeMs: s.mtimeMs, size: s.size, text })
      return text
    } catch (err) {
      problems.push({ file: name, level: 'error', message: `Could not read the file: ${err instanceof Error ? err.message : String(err)}` })
      return undefined
    }
  }
}

/** A valid role file to copy from. Named with a leading `_`, so it sits in the folder without loading until it is renamed. */
export const EXAMPLE_ROLE_FILE_NAME = '_example-role.md'
export const EXAMPLE_ROLE_FILE = `---
id: example-reporter                   # lower-case, hyphens only; must not be a built-in id
name: Example Reporter                 # label shown on chips and in the Agent: picker
summary: Summarises a file the user names into three bullet points. Does not edit files (Developer does) or search the web (Researcher).
description: Fuller text for capability listings and Settings only - never sent to the router.
examples: ["Summarise notes.txt in three bullets", "Give me the gist of report.md"]
notExamples: ["Rewrite notes.txt [coding]", "Find news about this topic [research]"]
tools: [read_file, list_directory]     # tool names, or a prefix ending in *  (e.g. "db_query_*", "mcp__wiki__*")
maxRounds: 6                           # optional
pickable: true                         # appears in the Agent: selector
plannable: true                        # a valid target for multi-step plans
---
You are the Example Reporter. Read the file the user names with read_file and reply with exactly three bullet points. Do not modify anything.
`
