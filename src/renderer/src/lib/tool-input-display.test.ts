import { describe, expect, it } from 'vitest'
import { formatToolInputForDisplay } from './tool-input-display'

describe('formatToolInputForDisplay (#109)', () => {
  it('shows a lone string argument as itself, with real line breaks', () => {
    expect(formatToolInputForDisplay(JSON.stringify({ command: 'python - <<EOF\nprint(1)\nEOF' }))).toBe('python - <<EOF\nprint(1)\nEOF')
  })

  it('shows several arguments as name: value lines, multi-line values under their name', () => {
    const input = JSON.stringify({ path: 'code/a.py', content: 'x = 1\ny = 2', overwrite: true })
    expect(formatToolInputForDisplay(input)).toBe('path: code/a.py\ncontent:\nx = 1\ny = 2\noverwrite: true')
  })

  it('keeps a long one-line command whole (wrapping is the CSS\'s job, not truncation)', () => {
    const cmd = 'echo ' + 'a'.repeat(400)
    expect(formatToolInputForDisplay(JSON.stringify({ command: cmd }))).toBe(cmd)
  })

  it('returns non-JSON and non-object input unchanged, and nothing for an empty object', () => {
    expect(formatToolInputForDisplay('{"command": "ls')).toBe('{"command": "ls')
    expect(formatToolInputForDisplay('[1,2]')).toBe('[1,2]')
    expect(formatToolInputForDisplay('')).toBe('')
    expect(formatToolInputForDisplay('{}')).toBe('')
  })
})
