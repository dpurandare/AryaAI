import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Tool } from './types'
import { checkUrlAllowed, recordKnownUrl } from './data-formats/link-registry'
import { FETCH_USER_AGENT } from './data-formats/source'
import { SHOW_MEDIA_MARKER, type ShowMediaPayload } from './show-media'
import { resolveNewFilePath, workspaceRelativePath } from './workspace-layout'

/** Same cap as show_media: a bigger file could not be displayed inline anyway. */
export const MAX_DOWNLOAD_IMAGE_BYTES = 5_000_000
const FETCH_TIMEOUT_MS = 30_000

/** What the bytes really are — never trusted from the URL or the Content-Type header, which a page controls. */
export function sniffImageExtension(bytes: Uint8Array): 'png' | 'jpg' | 'gif' | 'webp' | 'svg' | undefined {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  const head = Buffer.from(b.subarray(0, 512)).toString('utf-8').trimStart().toLowerCase()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg'
  return undefined
}

/** Loopback, private and link-local hosts: a web page (or a prompt-injected instruction) must not be able to point this tool at the user's own machine or network. Literal hostnames only — a name that merely resolves to a private address is not caught. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return h.includes(':')
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function safeBaseName(url: URL, hint: unknown): string {
  const raw = typeof hint === 'string' && hint.trim() ? hint : url.pathname.split('/').filter(Boolean).pop() ?? 'image'
  const noExt = raw.replace(/\.[A-Za-z0-9]{2,5}$/, '')
  const cleaned = noExt.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60)
  return cleaned || 'image'
}

export const downloadImageTool: Tool = {
  name: 'download_image',
  description:
    'Download one web image (PNG/JPEG/GIF/WebP/SVG, up to 5 MB) from a URL listed by parse_html or given by the user, ' +
    'save it to resources/ and show it to the user. You cannot see it: never say who or what it shows.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) URL of the image' },
      name: { type: 'string', description: 'Optional file name to save as, without extension' }
    },
    required: ['url']
  },
  mutates: true,
  describe(input) {
    return `Download image ${String(input.url ?? '')}`
  },
  async execute(input, ctx) {
    const urlText = String(input.url ?? '').trim()
    let url: URL
    try {
      url = new URL(urlText)
    } catch {
      throw new Error(`"${urlText}" is not a valid URL.`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https image URLs can be downloaded.')
    if (isPrivateHost(url.hostname)) throw new Error('That address is on this machine or a private network; only public web images can be downloaded.')
    const check = checkUrlAllowed(ctx.currentSessionId, urlText)
    if (!check.allowed) throw new Error(check.reason)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let bytes: Uint8Array
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': FETCH_USER_AGENT, Accept: 'image/*' } })
      if (!response.ok) {
        const wikimedia = response.status === 400 && /(^|\.)wikimedia\.org$/i.test(url.hostname)
        throw new Error(
          `Downloading ${urlText} failed: ${response.status} ${response.statusText}` +
            (wikimedia ? ' — Wikimedia serves only fixed thumbnail widths; take the exact image URL from the file page via parse_html instead of changing the number in it.' : '')
        )
      }
      if (isPrivateHost(new URL(response.url || urlText).hostname)) throw new Error('The image URL redirected to a private address; refused.')
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > MAX_DOWNLOAD_IMAGE_BYTES) throw new Error(`The image is ${declared} bytes, over the ${MAX_DOWNLOAD_IMAGE_BYTES}-byte limit — pick a smaller version of it (a thumbnail or lower resolution) from the page.`)
      bytes = new Uint8Array(await response.arrayBuffer())
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw new Error(`Downloading ${urlText} timed out after ${FETCH_TIMEOUT_MS / 1000}s.`)
      throw err
    } finally {
      clearTimeout(timer)
    }
    if (bytes.byteLength > MAX_DOWNLOAD_IMAGE_BYTES) throw new Error(`The image is ${bytes.byteLength} bytes, over the ${MAX_DOWNLOAD_IMAGE_BYTES}-byte limit — pick a smaller version of it (a thumbnail or lower resolution) from the page.`)
    const ext = sniffImageExtension(bytes)
    if (!ext) throw new Error('That URL did not return a PNG, JPEG, GIF, WebP or SVG image (it may be a web page or need a login).')

    const base = safeBaseName(url, input.name)
    let rel = `resources/${base}.${ext}`
    for (let n = 2; existsSync(resolveNewFilePath(ctx.workspaceGuard, rel)); n++) rel = `resources/${base}-${n}.${ext}`
    const abs = resolveNewFilePath(ctx.workspaceGuard, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, bytes)
    recordKnownUrl(ctx.currentSessionId, urlText)
    const saved = workspaceRelativePath(ctx.workspaceGuard.root, abs)
    const mimeType = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[ext]
    // Same payload show_media returns: the orchestrator turns it into a display-only image block for the user and tells
    // the model only "Displayed … to the user".
    const payload: ShowMediaPayload = {
      [SHOW_MEDIA_MARKER]: true,
      path: saved,
      mimeType,
      dataBase64: Buffer.from(bytes).toString('base64'),
      note: 'You have not seen the image: do not say who or what it shows, and do not call it official or genuine. If it came from a team or template page, say it may be a placeholder.'
    }
    return JSON.stringify(payload)
  }
}
