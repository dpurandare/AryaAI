import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import { parseXmlTool } from './xml'
import type { ToolContext } from '../types'

const SAMPLE_XML = `<root>
  <items>
    <item id="1"><name>a</name></item>
    <item id="2"><name>b</name></item>
  </items>
</root>`

describe('parse_xml', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-parse-xml-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
    await writeFile(join(root, 'data.xml'), SAMPLE_XML, 'utf-8')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('is never mutating', () => {
    expect(parseXmlTool.mutates).toBe(false)
  })

  it('summarizes the parsed shape by default', async () => {
    const result = await parseXmlTool.execute({ filePath: 'data.xml' }, ctx)
    expect(result).toContain('root:')
    expect(result).toContain('items:')
  })

  it('queries element text via a path', async () => {
    const result = await parseXmlTool.execute(
      { filePath: 'data.xml', action: 'query', path: 'root.items.item[0].name' },
      ctx
    )
    expect(result).toBe('"a"')
  })

  it('queries an attribute via the @_ prefix', async () => {
    const result = await parseXmlTool.execute(
      { filePath: 'data.xml', action: 'query', path: 'root.items.item[1].@_id' },
      ctx
    )
    expect(result).toBe('"2"')
  })

  it('expands a wildcard across repeated elements', async () => {
    const result = await parseXmlTool.execute(
      { filePath: 'data.xml', action: 'query', path: 'root.items.item[*].name' },
      ctx
    )
    expect(JSON.parse(result)).toEqual(['a', 'b'])
  })

  it('rejects invalid XML with a clear error', async () => {
    await expect(parseXmlTool.execute({ text: '<unclosed>' }, ctx)).rejects.toThrow(/Not valid XML/)
  })
})
