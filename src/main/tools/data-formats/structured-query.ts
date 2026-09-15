/**
 * A minimal, safe JSONPath-*like* path language shared by parse_json and
 * parse_xml (fast-xml-parser turns XML into the same kind of plain JS
 * value, so the same summarize/query/append logic applies to both without
 * duplicating it). Deliberately not a full JSONPath implementation —
 * supports dotted keys, numeric array indices, and a `[*]` wildcard, which
 * covers "get this field", "get item N", and "get this field from every
 * item" — the shapes an agent actually needs, without the complexity (or
 * eval-like risk surface) of a general expression language.
 */

const MAX_SUMMARY_DEPTH = 3
const MAX_KEYS_SHOWN = 30
const MAX_STRING_PREVIEW = 60

type PathToken = { kind: 'key'; name: string } | { kind: 'index'; index: number } | { kind: 'wildcard' }

/** Splits "a.b[0].c" / "$.items[*].name" / "" into tokens. A leading "$" or "$." is stripped; an empty/whitespace-only path yields no tokens (meaning "the whole value"). */
export function tokenizePath(path: string): PathToken[] {
  const cleaned = path.trim().replace(/^\$\.?/, '')
  if (!cleaned) return []
  const tokens: PathToken[] = []
  const regex = /([^[.\]]+)|\[(\*|\d+)\]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(cleaned))) {
    if (match[1] !== undefined) tokens.push({ kind: 'key', name: match[1] })
    else if (match[2] === '*') tokens.push({ kind: 'wildcard' })
    else tokens.push({ kind: 'index', index: Number(match[2]) })
  }
  return tokens
}

/** Evaluates a path against a value, returning every match — a wildcard can multiply one match into several, a missing key/out-of-range index just yields none (not an error, matching the tolerant spirit of "query what's there"). */
export function queryPath(value: unknown, path: string): unknown[] {
  let current: unknown[] = [value]
  for (const token of tokenizePath(path)) {
    const next: unknown[] = []
    for (const v of current) {
      if (token.kind === 'key') {
        if (v && typeof v === 'object' && !Array.isArray(v) && token.name in (v as object)) {
          next.push((v as Record<string, unknown>)[token.name])
        }
      } else if (token.kind === 'index') {
        if (Array.isArray(v) && token.index < v.length) next.push(v[token.index])
      } else {
        if (Array.isArray(v)) next.push(...v)
        else if (v && typeof v === 'object') next.push(...Object.values(v as object))
      }
    }
    current = next
  }
  return current
}

/** Appends `item` to the array found at `path` (or to the root itself when `path` is empty and the root is an array). Mutates `root` in place — the caller is responsible for persisting it. Deliberately narrow: no wildcards (ambiguous which array to append to) and no auto-creating intermediate objects beyond the final array field. */
export function appendAtPath(root: unknown, path: string, item: unknown): void {
  const tokens = tokenizePath(path)
  if (tokens.length === 0) {
    if (!Array.isArray(root)) throw new Error('Root is not an array — provide a path to an array field to append to.')
    root.push(item)
    return
  }

  let current: unknown = root
  for (const token of tokens.slice(0, -1)) {
    if (token.kind === 'wildcard') throw new Error('append does not support a wildcard path.')
    if (token.kind === 'key') {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error(`Path segment "${token.name}" is not an object.`)
      }
      current = (current as Record<string, unknown>)[token.name]
    } else {
      if (!Array.isArray(current)) throw new Error(`Path segment [${token.index}] expects an array.`)
      current = current[token.index]
    }
  }

  const last = tokens[tokens.length - 1]
  if (last.kind === 'wildcard') throw new Error('append does not support a wildcard path.')
  if (last.kind === 'key') {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(`Path segment "${last.name}" is not an object.`)
    }
    const obj = current as Record<string, unknown>
    if (obj[last.name] === undefined) obj[last.name] = []
    if (!Array.isArray(obj[last.name])) throw new Error(`"${last.name}" is not an array.`)
    ;(obj[last.name] as unknown[]).push(item)
  } else {
    if (!Array.isArray(current)) throw new Error(`Path segment [${last.index}] expects an array.`)
    const target = current[last.index]
    if (!Array.isArray(target)) throw new Error(`Element at [${last.index}] is not an array.`)
    target.push(item)
  }
}

function describeShape(value: unknown, depth: number): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (value.length === 0) return 'Array(0)'
    if (depth >= MAX_SUMMARY_DEPTH) return `Array(${value.length})`
    return `Array(${value.length}) of ${describeShape(value[0], depth + 1)}`
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as object)
    if (depth >= MAX_SUMMARY_DEPTH) return `{ ${keys.length} key(s) }`
    const shown = keys.slice(0, MAX_KEYS_SHOWN)
    const body = shown.map((k) => `${k}: ${describeShape((value as Record<string, unknown>)[k], depth + 1)}`)
    if (keys.length > shown.length) body.push('…')
    return `{ ${body.join(', ')} }`
  }
  if (typeof value === 'string') {
    const preview = value.length > MAX_STRING_PREVIEW ? `${value.slice(0, MAX_STRING_PREVIEW)}…` : value
    return `string ${JSON.stringify(preview)}`
  }
  return typeof value
}

/** A condensed, bounded description of a parsed value's shape — the point of this whole module: an agent can see what's there without the full (possibly huge) value ever entering its context. */
export function summarizeValue(value: unknown): string {
  return describeShape(value, 0)
}
