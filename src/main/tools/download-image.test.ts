import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import { SHOW_MEDIA_MARKER } from './show-media'
import { downloadImageTool, isPrivateHost, sniffImageExtension } from './download-image'
import { recordKnownUrl } from './data-formats/link-registry'
import type { ToolContext } from './types'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])

function fakeFetch(body: Uint8Array | string, init: { status?: number; headers?: Record<string, string>; url?: string } = {}) {
  return vi.fn(async () => {
    const res = new Response(typeof body === 'string' ? body : Buffer.from(body), { status: init.status ?? 200, headers: init.headers })
    Object.defineProperty(res, 'url', { value: init.url ?? 'https://example.com/x.png' })
    return res
  })
}

describe('download_image', () => {
  let root: string
  let ctx: ToolContext
  let n = 0

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-dlimg-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: `dl-${++n}` }
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(root, { recursive: true, force: true })
  })

  it('recognises images by their bytes, not their name or content type', () => {
    expect(sniffImageExtension(PNG)).toBe('png')
    expect(sniffImageExtension(JPG)).toBe('jpg')
    expect(sniffImageExtension(Buffer.from('GIF89a....'))).toBe('gif')
    expect(sniffImageExtension(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp')
    expect(sniffImageExtension(Buffer.from('<?xml version="1.0"?><svg xmlns=""/>'))).toBe('svg')
    expect(sniffImageExtension(Buffer.from('<html><body>login</body></html>'))).toBeUndefined()
  })

  it('treats this machine and private networks as off limits, and ordinary hosts as fine', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.0.1', '169.254.1.1', '::1', 'printer.local']) expect(isPrivateHost(h), h).toBe(true)
    for (const h of ['example.com', 'jade-biz.com', '8.8.8.8', '172.32.0.1', 'fcbarcelona.com']) expect(isPrivateHost(h), h).toBe(false)
  })

  it('saves the image under resources/ and returns the display payload, so the user sees it', async () => {
    vi.stubGlobal('fetch', fakeFetch(PNG, { headers: { 'content-type': 'image/png' } }))
    const out = String(await downloadImageTool.execute({ url: 'https://example.com/team/Vinod Photo.png', name: 'vinod' }, ctx))
    const payload = JSON.parse(out)
    expect(payload[SHOW_MEDIA_MARKER]).toBe(true)
    expect(payload.path).toBe('resources/vinod.png')
    expect(payload.mimeType).toBe('image/png')
    expect(Buffer.from(payload.dataBase64, 'base64').equals(Buffer.from(PNG))).toBe(true)
    expect((await readFile(join(root, 'resources', 'vinod.png'))).equals(Buffer.from(PNG))).toBe(true)
  })

  it('does not overwrite an existing file: the next one gets a numbered name', async () => {
    vi.stubGlobal('fetch', fakeFetch(JPG))
    await downloadImageTool.execute({ url: 'https://one.test/a/pic.jpg' }, ctx)
    const second = JSON.parse(String(await downloadImageTool.execute({ url: 'https://two.test/b/pic.jpg' }, ctx)))
    expect(second.path).toBe('resources/pic-2.jpg')
  })

  it('refuses a page that is not an image, with nothing saved', async () => {
    vi.stubGlobal('fetch', fakeFetch('<html>please log in</html>', { headers: { 'content-type': 'text/html' } }))
    await expect(downloadImageTool.execute({ url: 'https://example.com/photo.png' }, ctx)).rejects.toThrow(/did not return a PNG, JPEG/)
    expect(existsSync(join(root, 'resources'))).toBe(false)
  })

  it('refuses private addresses, non-http URLs, oversize images and failed requests', async () => {
    const fetchMock = fakeFetch(PNG)
    vi.stubGlobal('fetch', fetchMock)
    await expect(downloadImageTool.execute({ url: 'http://127.0.0.1:8080/a.png' }, ctx)).rejects.toThrow(/private network/)
    await expect(downloadImageTool.execute({ url: 'file:///etc/passwd' }, ctx)).rejects.toThrow(/http and https/)
    await expect(downloadImageTool.execute({ url: 'not a url' }, ctx)).rejects.toThrow(/not a valid URL/)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.stubGlobal('fetch', fakeFetch(PNG, { headers: { 'content-length': '9000000' } }))
    await expect(downloadImageTool.execute({ url: 'https://example.com/big.png' }, ctx)).rejects.toThrow(/over the 5000000-byte limit/)
    vi.stubGlobal('fetch', fakeFetch('nope', { status: 404 }))
    await expect(downloadImageTool.execute({ url: 'https://example.com/gone.png' }, ctx)).rejects.toThrow(/404/)
    vi.stubGlobal('fetch', fakeFetch(PNG, { url: 'http://192.168.1.1/a.png' }))
    await expect(downloadImageTool.execute({ url: 'https://example.com/redirect.png' }, ctx)).rejects.toThrow(/redirected to a private address/)
  })

  it('refuses an invented path on a site whose real links are already known, and accepts a real one', async () => {
    vi.stubGlobal('fetch', fakeFetch(PNG))
    recordKnownUrl(ctx.currentSessionId, 'https://site.test/real/photo.png')
    await expect(downloadImageTool.execute({ url: 'https://site.test/made/up.png' }, ctx)).rejects.toThrow(/doesn't match any real link/)
    await expect(downloadImageTool.execute({ url: 'https://site.test/real/photo.png' }, ctx)).resolves.toContain('resources/photo.png')
  })

  it('always asks for confirmation and says what it will fetch', () => {
    expect(downloadImageTool.mutates).toBe(true)
    expect(downloadImageTool.describe?.({ url: 'https://example.com/a.png' })).toBe('Download image https://example.com/a.png')
  })

  it('explains how to recover from Wikimedia\'s fixed-thumbnail-size 400 and from an oversize image', async () => {
    vi.stubGlobal('fetch', fakeFetch('Use thumbnail sizes listed on https://w.wiki/GHai', { status: 400, url: 'https://upload.wikimedia.org/x.jpg' }))
    await expect(downloadImageTool.execute({ url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/56/X.jpg/300px-X.jpg' }, ctx)).rejects.toThrow(/fixed thumbnail widths.*parse_html/)
    vi.stubGlobal('fetch', fakeFetch(PNG, { headers: { 'content-length': '9000000' } }))
    await expect(downloadImageTool.execute({ url: 'https://example.com/big.png' }, ctx)).rejects.toThrow(/pick a smaller version/)
  })

  it('tells the model it has not seen the picture, inside the display payload', async () => {
    vi.stubGlobal('fetch', fakeFetch(PNG))
    const payload = JSON.parse(String(await downloadImageTool.execute({ url: 'https://example.com/p.png' }, ctx)))
    expect(payload.note).toMatch(/not seen the image.*placeholder/)
  })
})
