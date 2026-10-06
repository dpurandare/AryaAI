import { writeFile } from 'node:fs/promises'
import type { Tool } from '../types'
import { resolveSource, sourceExternalPaths } from './source'
import { appendAtPath, queryPath, summarizeValue } from './structured-query'

const MAX_RESULT_CHARS = 8_000

function formatResult(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
  if (text.length <= MAX_RESULT_CHARS) return text
  return `${text.slice(0, MAX_RESULT_CHARS)}\n... (truncated, ${text.length - MAX_RESULT_CHARS} characters omitted)`
}

export const parseJsonTool: Tool = {
  name: 'parse_json',
  description:
    'Parse and work with JSON without pulling the whole (possibly huge) structure into your own ' +
    'context. Provide exactly one of url, filePath, or text. action defaults to "summarize" — a ' +
    "condensed description of the value's shape (keys/types, array lengths), not the full value. " +
    '"query" extracts a specific value or set of values via a simple path (dot/bracket keys, numeric ' +
    'indices, and a [*] wildcard — e.g. "items[*].name", "data.users[0].email"). "append" pushes one ' +
    'new item onto the array found at path (path empty means the root itself, which must be an array) ' +
    'and requires filePath, since it writes back to the file — this is the only action that mutates ' +
    'anything; there is no update/delete of existing items.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      filePath: { type: 'string', description: 'Path to a JSON file, relative to the workspace root' },
      text: { type: 'string' },
      action: { type: 'string', enum: ['summarize', 'query', 'append'] },
      path: { type: 'string', description: 'query/append: e.g. "items[*].name" — empty/omitted means the whole value' },
      item: { description: 'append: the value to push onto the array at path' }
    }
  },
  mutates: (input) => input.action === 'append',
  externalPaths: sourceExternalPaths,
  describe(input) {
    if (input.action === 'append') return `Append to "${String(input.filePath ?? '')}" at path "${String(input.path ?? '')}": ${JSON.stringify(input.item)}`
    return `parse_json ${String(input.action ?? 'summarize')} on "${String(input.filePath ?? input.url ?? '(inline)')}"`
  },
  async execute(input, ctx) {
    const action = String(input.action ?? 'summarize')
    const { text, writeBackPath } = await resolveSource(input, ctx)

    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (err) {
      throw new Error(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (action === 'summarize') return summarizeValue(value)

    const path = typeof input.path === 'string' ? input.path : ''

    if (action === 'query') {
      const matches = queryPath(value, path)
      if (matches.length === 0) return '(no match for that path)'
      return matches.length === 1 ? formatResult(matches[0]) : formatResult(matches)
    }

    if (action === 'append') {
      if (!writeBackPath) throw new Error('append requires a filePath inside the workspace (a url/text source, or a file outside the workspace, cannot be written back to).')
      appendAtPath(value, path, input.item)
      await writeFile(writeBackPath, JSON.stringify(value, null, 2), 'utf-8')
      return `Appended 1 item at "${path || '(root)'}".`
    }

    throw new Error(`Unknown action "${action}".`)
  }
}
