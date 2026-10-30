/**
 * TASKS #229: a file dropped on the message box inserts its full path into the message, not its contents. Pure text work, so it
 * is unit-tested; the paths themselves come from Electron's `webUtils.getPathForFile` (preload).
 */

/** A path as it is written in a message: bare, or in double quotes when it contains whitespace (so the model reads it as one path). */
export function formatDroppedPath(path: string): string {
  return /\s/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path
}

/** The text to insert for the dropped files: one path per line when several, nothing when no file had a path (e.g. text dragged from a web page). */
export function formatDroppedPaths(paths: readonly string[]): string {
  const real = paths.filter((p) => p.length > 0)
  if (real.length === 0) return ''
  return real.map(formatDroppedPath).join(real.length > 1 ? '\n' : ' ')
}

/**
 * Appends the dropped paths to what is already typed, separated so that a path never glues onto a word: a space after text on the
 * same line, nothing after an empty draft or a trailing newline.
 */
export function insertDroppedPaths(draft: string, paths: readonly string[]): string {
  const text = formatDroppedPaths(paths)
  if (!text) return draft
  if (draft === '' || draft.endsWith('\n') || draft.endsWith(' ')) return draft + text
  return draft + (text.includes('\n') ? '\n' : ' ') + text
}
