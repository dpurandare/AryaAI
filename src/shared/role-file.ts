import { explainInvalidRoleId, type RoleMeta } from './agents'
import { lintRoleStructure, lintRoutingSummary } from './role-lint'

/**
 * User-defined roles (design-discussion.md section 11): one Markdown file per role, with frontmatter and the role's system prompt as the
 * body. This module is the pure half — parsing and validating a file's text — so the same code serves the loader, the tests and (later)
 * an import path. It does no I/O.
 *
 *   ---
 *   id: sql-reporter                     # lower-case, hyphens only, unique; never a built-in id
 *   name: SQL Reporter                   # label for chips and the picker
 *   summary: Runs read-only SQL and returns a formatted summary; does not modify data (Data Access does writes).
 *   description: Fuller text for capability listings — never sent to the router.
 *   examples: ["Show last month's revenue by region", "How many orders were placed today?"]
 *   notExamples: ["Update the customer table"]
 *   tools: [db_list_connections, db_execute_sql, "db_query_*"]   # names, or a prefix ending in *
 *   maxRounds: 6                         # optional
 *   isolated: false                      # optional: brief-only context
 *   pickable: true                       # appears in the Agent: selector
 *   plannable: true                      # valid classify-and-plan target
 *   ---
 *   The role's system prompt: its few procedures.
 *
 * A role file only ever SELECTS existing tools and shapes a prompt — it never defines executable code, and confirmation and the workspace
 * guard are enforced per tool, so a role cannot grant itself anything the tools do not already gate (design 11.1).
 */

export const ROLE_FILE_LIMITS = {
  fileBytes: 32 * 1024,
  promptChars: 8_000,
  summaryChars: 500,
  nameChars: 40,
  toolPatterns: 40,
  examples: 10,
  maxRounds: 30,
  /** Roles loaded from the folder at most — a runaway folder must not flood the router (every summary reaches it every turn). */
  roles: 20
} as const

export interface RoleFileIssue {
  level: 'error' | 'warning'
  message: string
}

export interface ParsedFrontmatter {
  data: Record<string, unknown>
  body: string
  issues: RoleFileIssue[]
}

const KNOWN_KEYS = new Set(['id', 'name', 'summary', 'description', 'examples', 'notExamples', 'tools', 'maxRounds', 'isolated', 'pickable', 'plannable'])

/** Removes a trailing ` # comment` that is not inside quotes. */
function stripComment(value: string): string {
  let quote: string | undefined
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = undefined
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i)
  }
  return value
}

function unquote(s: string): string {
  const t = s.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string
    } catch {
      return t.slice(1, -1)
    }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'")
  return t
}

function splitTopLevel(inner: string): string[] {
  const parts: string[] = []
  let cur = ''
  let quote: string | undefined
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"' && i + 1 < inner.length) cur += inner[++i]
      else if (c === quote) quote = undefined
    } else if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (c === ',') {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur.trim() || parts.length) parts.push(cur)
  return parts.map((p) => p.trim()).filter((p) => p !== '')
}

function parseValue(raw: string): { value?: unknown; error?: string } {
  const v = stripComment(raw).trim()
  if (v === '') return { value: '' }
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) return { error: 'a list must be written on one line, like [a, b, "c"]' }
    return { value: splitTopLevel(v.slice(1, -1)).map(unquote) }
  }
  if (v.startsWith('"') || v.startsWith("'")) {
    if (v.length < 2 || !v.endsWith(v[0])) return { error: 'an opening quote has no closing quote on the same line' }
    return { value: unquote(v) }
  }
  if (v === 'true') return { value: true }
  if (v === 'false') return { value: false }
  if (/^-?\d+(\.\d+)?$/.test(v)) return { value: Number(v) }
  return { value: v }
}

/** A deliberately small subset of YAML: `key: value` lines, one-line lists, quoted or bare strings, booleans, numbers, `#` comments. */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const issues: RoleFileIssue[] = []
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text.replace(/^﻿/, ''))
  if (!m) return { data: {}, body: '', issues: [{ level: 'error', message: 'The file must start with a "---" frontmatter block (closed by another "---") followed by the role\'s prompt.' }] }
  const data: Record<string, unknown> = {}
  for (const [i, line] of m[1].split(/\r?\n/).entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const kv = /^([A-Za-z][A-Za-z0-9]*):(?:\s+(.*)|\s*)$/.exec(line)
    if (!kv) {
      issues.push({ level: 'error', message: `Frontmatter line ${i + 1} is not "key: value" (only single-line values are supported).` })
      continue
    }
    const [, key, raw = ''] = kv
    if (key in data) issues.push({ level: 'error', message: `"${key}" is given more than once.` })
    const parsed = parseValue(raw)
    if (parsed.error) issues.push({ level: 'error', message: `"${key}": ${parsed.error}.` })
    else data[key] = parsed.value
    if (!KNOWN_KEYS.has(key)) issues.push({ level: 'warning', message: `Unknown field "${key}" is ignored.` })
  }
  return { data, body: m[2].trim(), issues }
}

/** A validated role file. */
export interface RoleFile {
  id: string
  name: string
  summary: string
  description: string
  examples: string[]
  notExamples: string[]
  /** Exact tool names, or a prefix followed by `*`. */
  tools: string[]
  maxRounds?: number
  isolated: boolean
  pickable: boolean
  plannable: boolean
  /** The role's system prompt (the file body). */
  prompt: string
}

export interface RoleFileContext {
  /** Every id already in use by another role (extend-only: built-in ids are always rejected regardless). */
  takenIds?: Iterable<string>
  /** The other roles' metadata, for the routing-summary lint (overlap, hand-off). */
  siblings?: readonly RoleMeta[]
}

function stringList(value: unknown, field: string, issues: RoleFileIssue[], max: number): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
    issues.push({ level: 'error', message: `"${field}" must be a list of strings.` })
    return []
  }
  const list = (value as string[]).map((x) => x.trim()).filter(Boolean)
  if (list.length > max) {
    issues.push({ level: 'error', message: `"${field}" has ${list.length} entries; the limit is ${max}.` })
    return list.slice(0, max)
  }
  return list
}

/**
 * Validates a role file. Structural problems (bad id, missing fields, wrong types, size caps, malformed tool patterns) are **errors** — the
 * role is not loaded. Quality problems (the routing-summary lint of design 3.2: over-broad wording, no named hand-off, overlap; too few
 * examples; no tools) are **warnings** — the role loads and the Settings panel shows them (design 11.3).
 */
export function validateRoleFile(text: string, ctx: RoleFileContext = {}): { role?: RoleFile; issues: RoleFileIssue[] } {
  const { data, body, issues } = parseFrontmatter(text)
  // No frontmatter block at all: that one error explains everything; "id / name / summary / prompt missing" on top of it is just noise.
  if (issues.some((i) => i.level === 'error' && /must start with a "---" frontmatter block/.test(i.message))) return { issues }
  const err = (message: string): void => void issues.push({ level: 'error', message })
  const warn = (message: string): void => void issues.push({ level: 'warning', message })
  const L = ROLE_FILE_LIMITS

  const idProblem = explainInvalidRoleId(data.id, ctx.takenIds ?? [])
  if (idProblem) err(`id: ${idProblem}`)

  const str = (key: string, required: boolean, max: number): string => {
    const v = data[key]
    if (v === undefined || v === '') {
      if (required) err(`"${key}" is required.`)
      return ''
    }
    if (typeof v !== 'string') {
      err(`"${key}" must be text.`)
      return ''
    }
    if (v.length > max) err(`"${key}" is ${v.length} characters; the limit is ${max}.`)
    return v.trim()
  }
  const name = str('name', true, L.nameChars)
  const summary = str('summary', true, L.summaryChars)
  const description = str('description', false, 2_000)

  const examples = stringList(data.examples, 'examples', issues, L.examples)
  const notExamples = stringList(data.notExamples, 'notExamples', issues, L.examples)
  const tools = stringList(data.tools, 'tools', issues, L.toolPatterns)
  for (const t of tools) {
    if (!/^[A-Za-z0-9_-]+\*?$/.test(t)) err(`tools: "${t}" is not a tool name or a prefix ending in * (letters, digits, _ and - only).`)
  }

  const bool = (key: string, dflt: boolean): boolean => {
    const v = data[key]
    if (v === undefined) return dflt
    if (typeof v !== 'boolean') {
      err(`"${key}" must be true or false.`)
      return dflt
    }
    return v
  }
  const isolated = bool('isolated', false)
  const pickable = bool('pickable', true)
  const plannable = bool('plannable', true)

  let maxRounds: number | undefined
  if (data.maxRounds !== undefined) {
    const n = data.maxRounds
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > L.maxRounds) err(`"maxRounds" must be a whole number from 1 to ${L.maxRounds}.`)
    else maxRounds = n
  }

  if (!body) err('The file has no prompt after the frontmatter — the body is the role\'s system prompt.')
  else if (body.length > L.promptChars) err(`The prompt is ${body.length} characters; the limit is ${L.promptChars}.`)

  if (issues.some((i) => i.level === 'error') || idProblem) return { issues }

  // Quality checks: warnings only.
  const meta: RoleMeta = { id: data.id as string, label: name, summary, description: description || summary, pickable, plannable, examples, notExamples }
  const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1)
  for (const i of lintRoleStructure([meta])) warn(`${cap(i.message)}.`)
  for (const i of lintRoutingSummary(meta, ctx.siblings ?? [])) warn(`Routing summary: ${i.message.replace(/^summary\s+/, '')}.`)
  if (tools.length === 0) warn('No tools: this role can only reason and answer in text.')

  return {
    role: { id: meta.id, name, summary, description: meta.description, examples, notExamples, tools, maxRounds, isolated, pickable, plannable, prompt: body },
    issues
  }
}

/** Whether a role's tool pattern matches a tool name (exact, or prefix when it ends in `*`). */
export function toolMatchesPattern(pattern: string, toolName: string): boolean {
  return pattern.endsWith('*') ? toolName.startsWith(pattern.slice(0, -1)) : toolName === pattern
}
