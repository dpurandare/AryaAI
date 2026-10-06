import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import { resolveSource } from './source'
import type { ToolContext } from '../types'

describe('resolveSource', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-source-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('rejects when none of url/filePath/text is given', async () => {
    await expect(resolveSource({}, ctx)).rejects.toThrow(/exactly one of/)
  })

  it('rejects when more than one is given', async () => {
    await expect(resolveSource({ url: 'https://x', text: 'y' }, ctx)).rejects.toThrow(/exactly one of/)
  })

  it('treats an empty string the same as not provided — a model that fills in every schema field rather than omitting unused ones should not get a confusing rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('fetched body', { status: 200 })))
    // Real shape confirmed live: gpt-oss passed url alongside filePath: "" and text: "" in one call.
    const result = await resolveSource({ url: 'https://example.com/x', filePath: '', text: '' }, ctx)
    expect(result).toEqual({ text: 'fetched body' })
    vi.unstubAllGlobals()
  })

  it('still rejects when the only non-empty field is missing and the rest are blank', async () => {
    await expect(resolveSource({ url: '', filePath: '', text: '' }, ctx)).rejects.toThrow(/exactly one of/)
  })

  it('uses the one genuinely non-empty field even when it is not url (ordering safety)', async () => {
    await writeFile(join(root, 'data.txt'), 'from disk', 'utf-8')
    const result = await resolveSource({ url: '', filePath: 'data.txt', text: '' }, ctx)
    expect(result.text).toBe('from disk')
  })

  it('reads inline text as-is, with no writeBackPath', async () => {
    const result = await resolveSource({ text: 'hello' }, ctx)
    expect(result).toEqual({ text: 'hello' })
  })

  it('reads a workspace file and reports its resolved path as writeBackPath', async () => {
    await writeFile(join(root, 'data.txt'), 'from disk', 'utf-8')
    const result = await resolveSource({ filePath: 'data.txt' }, ctx)
    expect(result.text).toBe('from disk')
    expect(result.writeBackPath).toBe(join(root, 'data.txt'))
  })

  it('refuses a file path outside the workspace', async () => {
    await expect(resolveSource({ filePath: '../outside.txt' }, ctx)).rejects.toThrow(/outside the workspace/)
  })

  it('fetches a URL directly, with no writeBackPath', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('fetched body', { status: 200 })))
    const result = await resolveSource({ url: 'https://example.com/x' }, ctx)
    expect(result).toEqual({ text: 'fetched body' })
    vi.unstubAllGlobals()
  })

  it('throws a clear error on a non-OK fetch response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404, statusText: 'Not Found' })))
    await expect(resolveSource({ url: 'https://example.com/x' }, ctx)).rejects.toThrow(/404/)
    vi.unstubAllGlobals()
  })

  describe('refusing what is not a page or a data file (found live: a PDF froze the app for ~100 seconds)', () => {
    afterEach(() => vi.unstubAllGlobals())
    const stub = (body: BodyInit, headers: Record<string, string>) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers })))

    it('refuses a PDF by its Content-Type before reading it, with a message that says what to do', async () => {
      stub('%PDF-1.7 ...', { 'content-type': 'application/pdf' })
      await expect(resolveSource({ url: 'https://example.com/report.pdf' }, ctx)).rejects.toThrow(/is a PDF, not a web page or text data.*stall the app.*HTML version/)
    })

    it('refuses pictures, archives and office files by Content-Type, but not HTML, JSON, CSV, plain text or an unlabelled stream', async () => {
      for (const type of ['image/png', 'video/mp4', 'application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/x-msdownload']) {
        stub('xx', { 'content-type': type })
        await expect(resolveSource({ url: 'https://example.com/f' }, ctx), type).rejects.toThrow(/cannot be read here/)
      }
      for (const type of ['text/html; charset=utf-8', 'application/json', 'text/csv', 'text/plain', 'application/octet-stream', 'application/xml']) {
        stub('<p>ok</p>', { 'content-type': type })
        await expect(resolveSource({ url: 'https://example.com/f' }, ctx), type).resolves.toMatchObject({ text: '<p>ok</p>' })
      }
    })

    it('catches a PDF served with a wrong or missing Content-Type by its first bytes', async () => {
      stub('%PDF-1.4\n%binary', { 'content-type': 'text/html' })
      await expect(resolveSource({ url: 'https://example.com/disguised' }, ctx)).rejects.toThrow(/is a PDF/)
    })

    it('refuses a body over the size limit — by the declared length, and by counting when none is declared', async () => {
      stub('x', { 'content-type': 'text/html', 'content-length': '9000000' })
      await expect(resolveSource({ url: 'https://example.com/big' }, ctx)).rejects.toThrow(/over the 5000000-byte limit/)
      stub('y'.repeat(5_100_000), { 'content-type': 'text/html' })
      await expect(resolveSource({ url: 'https://example.com/streamed' }, ctx)).rejects.toThrow(/larger than the 5000000-byte limit/)
    })
  })
})
