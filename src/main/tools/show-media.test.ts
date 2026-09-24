import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import { SHOW_MEDIA_MARKER, showMediaTool, type ShowMediaPayload } from './show-media'
import type { ToolContext } from './types'

describe('show_media', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-show-media-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('is never mutating — a display-only read of an existing file', () => {
    expect(showMediaTool.mutates).toBe(false)
  })

  it('reads a real image and returns the marker payload with correct base64 bytes and MIME type', async () => {
    // A minimal real 1x1 PNG (not a fabricated placeholder) — the classic
    // smallest-valid-PNG byte sequence.
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
        '01f15c4890000000a49444154789c626001000000050001fce34d970000000049454e44ae426082',
      'hex'
    )
    await writeFile(join(root, 'chart.png'), pngBytes)

    const result = await showMediaTool.execute({ path: 'chart.png' }, ctx)
    const parsed = JSON.parse(result) as ShowMediaPayload
    expect(parsed[SHOW_MEDIA_MARKER]).toBe(true)
    expect(parsed.path).toBe('chart.png')
    expect(parsed.mimeType).toBe('image/png')
    expect(Buffer.from(parsed.dataBase64, 'base64')).toEqual(pngBytes)
  })

  it('recognizes every supported extension with the right MIME type', async () => {
    const cases: [string, string][] = [
      ['a.jpg', 'image/jpeg'],
      ['a.jpeg', 'image/jpeg'],
      ['a.gif', 'image/gif'],
      ['a.webp', 'image/webp'],
      ['a.svg', 'image/svg+xml']
    ]
    for (const [name, mimeType] of cases) {
      await writeFile(join(root, name), 'x')
      const result = await showMediaTool.execute({ path: name }, ctx)
      expect((JSON.parse(result) as ShowMediaPayload).mimeType).toBe(mimeType)
    }
  })

  it('rejects an unsupported extension with a clear message, not a silent guess', async () => {
    await writeFile(join(root, 'clip.mp4'), 'x')
    await expect(showMediaTool.execute({ path: 'clip.mp4' }, ctx)).rejects.toThrow(/not a supported image type/i)
  })

  it('rejects a file over the inline-display size limit', async () => {
    await writeFile(join(root, 'huge.png'), Buffer.alloc(6_000_000))
    await expect(showMediaTool.execute({ path: 'huge.png' }, ctx)).rejects.toThrow(/over the .*-byte inline display limit/i)
  })

  it('rejects a path outside the workspace, same guard every other file tool uses', async () => {
    await expect(showMediaTool.execute({ path: '../outside.png' }, ctx)).rejects.toThrow(/workspace boundary/i)
  })

  it('rejects an empty path', async () => {
    await expect(showMediaTool.execute({ path: '  ' }, ctx)).rejects.toThrow(/no path given/i)
  })

  it('rejects a path to a file that does not exist', async () => {
    await expect(showMediaTool.execute({ path: 'nope.png' }, ctx)).rejects.toThrow()
  })
})
