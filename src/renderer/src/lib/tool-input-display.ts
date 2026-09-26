/**
 * How a tool call's input is shown when its block is expanded (TASKS.md #109). The stored `input` is `JSON.stringify(args)`, so a multi-line
 * script or SQL statement arrives with its line breaks escaped as `\n` on one long line. This turns it back into readable text:
 *  - a single string argument (`{command}`, `{sql}`, `{path}`) is shown as just that string, with its real line breaks;
 *  - several arguments are shown as `name: value` lines (a multi-line value starts on its own line, under the name);
 *  - anything that isn't a JSON object (a partial stream, a plain string) is shown as it is.
 */
export function formatToolInputForDisplay(input: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return input
  }
  if (typeof parsed === 'string') return parsed
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return input
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length === 0) return ''
  const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))
  if (entries.length === 1 && typeof entries[0][1] === 'string') return entries[0][1]
  return entries
    .map(([k, v]) => {
      const text = show(v)
      return text.includes('\n') ? `${k}:\n${text}` : `${k}: ${text}`
    })
    .join('\n')
}
