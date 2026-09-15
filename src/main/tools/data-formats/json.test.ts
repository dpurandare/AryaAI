import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import { parseJsonTool } from './json'
import type { ToolContext } from '../types'

const SAMPLE = JSON.stringify({ items: [{ name: 'a' }, { name: 'b' }], count: 2 })

describe('parse_json', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-parse-json-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
    await writeFile(join(root, 'data.json'), SAMPLE, 'utf-8')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('mutates only for the append action', () => {
    const mutates = parseJsonTool.mutates as (input: Record<string, unknown>) => boolean
    expect(mutates({ action: 'summarize' })).toBe(false)
    expect(mutates({ action: 'query' })).toBe(false)
    expect(mutates({ action: 'append' })).toBe(true)
  })

  it('summarizes the shape by default, not the full value', async () => {
    const result = await parseJsonTool.execute({ filePath: 'data.json' }, ctx)
    expect(result).toBe('{ items: Array(2) of { name: string "a" }, count: number }')
  })

  it('queries a path, returning the single match unwrapped', async () => {
    expect(await parseJsonTool.execute({ filePath: 'data.json', action: 'query', path: 'count' }, ctx)).toBe('2')
  })

  it('queries a wildcard path, returning an array of matches', async () => {
    const result = await parseJsonTool.execute({ filePath: 'data.json', action: 'query', path: 'items[*].name' }, ctx)
    expect(JSON.parse(result)).toEqual(['a', 'b'])
  })

  it('reports no match plainly rather than erroring', async () => {
    expect(await parseJsonTool.execute({ filePath: 'data.json', action: 'query', path: 'nope' }, ctx)).toBe(
      '(no match for that path)'
    )
  })

  it('rejects invalid JSON with a clear error', async () => {
    await parseJsonTool.execute({ filePath: 'data.json' }, ctx) // sanity: file itself is valid
    await expect(parseJsonTool.execute({ text: '{not json' }, ctx)).rejects.toThrow(/Not valid JSON/)
  })

  it('appends an item to the array at a path and writes it back', async () => {
    const result = await parseJsonTool.execute(
      { filePath: 'data.json', action: 'append', path: 'items', item: { name: 'c' } },
      ctx
    )
    expect(result).toBe('Appended 1 item at "items".')

    const written = JSON.parse(await readFile(join(root, 'data.json'), 'utf-8'))
    expect(written.items).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }])
  })

  it('appends to the root when it is itself an array and no path is given', async () => {
    await writeFile(join(root, 'list.json'), JSON.stringify([1, 2]), 'utf-8')
    await parseJsonTool.execute({ filePath: 'list.json', action: 'append', item: 3 }, ctx)
    expect(JSON.parse(await readFile(join(root, 'list.json'), 'utf-8'))).toEqual([1, 2, 3])
  })

  it('rejects append when the source is not a file', async () => {
    await expect(parseJsonTool.execute({ text: SAMPLE, action: 'append', path: 'items', item: {} }, ctx)).rejects.toThrow(
      /append requires filePath/
    )
  })
})
