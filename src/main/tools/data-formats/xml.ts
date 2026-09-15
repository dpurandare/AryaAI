import { XMLParser, XMLValidator } from 'fast-xml-parser'
import type { Tool } from '../types'
import { resolveSource } from './source'
import { queryPath, summarizeValue } from './structured-query'

const MAX_RESULT_CHARS = 8_000

// Attributes land as ordinary object keys prefixed "@_" (fast-xml-parser's
// own convention) rather than a separate shape — same summarizeValue/
// queryPath logic as parse_json then applies unchanged; a path like
// "item[0].@_id" reaches an attribute exactly like any other key.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })

function formatResult(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
  if (text.length <= MAX_RESULT_CHARS) return text
  return `${text.slice(0, MAX_RESULT_CHARS)}\n... (truncated, ${text.length - MAX_RESULT_CHARS} characters omitted)`
}

export const parseXmlTool: Tool = {
  name: 'parse_xml',
  description:
    'Parse and query XML without pulling the raw markup into your own context — converted internally ' +
    'to the same kind of value JSON would parse to (element text/children as keys, attributes as ' +
    '"@_name" keys), then summarized or queried the same way as parse_json. Provide exactly one of ' +
    'url, filePath, or text. action defaults to "summarize" (a condensed shape description). "query" ' +
    'extracts a value via a simple path (dot/bracket keys, numeric indices, [*] wildcard). Read-only — ' +
    'there is no write/append action for XML.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      filePath: { type: 'string', description: 'Path to an XML file, relative to the workspace root' },
      text: { type: 'string' },
      action: { type: 'string', enum: ['summarize', 'query'] },
      path: { type: 'string', description: 'query: e.g. "root.items.item[*].@_id" — empty/omitted means the whole value' }
    }
  },
  mutates: false,
  async execute(input, ctx) {
    const action = String(input.action ?? 'summarize')
    const { text } = await resolveSource(input, ctx)

    // fast-xml-parser's own parse() is lenient by design (it won't throw on
    // e.g. an unclosed or mismatched tag, just does its best) — validate
    // explicitly first so malformed input gets a real, clear error instead
    // of a silently-wrong parse.
    const validation = XMLValidator.validate(text)
    if (validation !== true) {
      throw new Error(`Not valid XML: ${validation.err.msg} (line ${validation.err.line}, col ${validation.err.col})`)
    }
    const value: unknown = parser.parse(text)

    if (action === 'summarize') return summarizeValue(value)

    if (action === 'query') {
      const path = typeof input.path === 'string' ? input.path : ''
      const matches = queryPath(value, path)
      if (matches.length === 0) return '(no match for that path)'
      return matches.length === 1 ? formatResult(matches[0]) : formatResult(matches)
    }

    throw new Error(`Unknown action "${action}".`)
  }
}
