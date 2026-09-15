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
})
