import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import { shellExecuteTool } from './shell'
import type { ToolContext } from './types'

describe('shell_execute', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-shell-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root) }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('is always mutating', () => {
    expect(shellExecuteTool.mutates).toBe(true)
  })

  it('describes the command literally', () => {
    expect(shellExecuteTool.describe?.({ command: 'ls -la' })).toBe('Run: ls -la')
  })

  it('runs a command with cwd fixed to the workspace root', async () => {
    const result = await shellExecuteTool.execute({ command: 'pwd' }, ctx)
    expect(result).toContain('exit code: 0')
    // On macOS /tmp is a symlink to /private/tmp — `pwd` may report either.
    expect(result).toMatch(new RegExp(root.replace('/private', '(/private)?')))
  })

  it('captures stdout', async () => {
    const result = await shellExecuteTool.execute({ command: 'echo hello' }, ctx)
    expect(result).toContain('exit code: 0')
    expect(result).toContain('stdout:\nhello')
  })

  it('captures a nonzero exit code and stderr', async () => {
    const result = await shellExecuteTool.execute({ command: 'echo oops 1>&2; exit 3' }, ctx)
    expect(result).toContain('exit code: 3')
    expect(result).toContain('stderr:\noops')
  })

  it('can actually write a file into the workspace', async () => {
    await shellExecuteTool.execute({ command: 'echo written > out.txt' }, ctx)
    expect(await readFile(join(root, 'out.txt'), 'utf-8')).toBe('written\n')
  })

  it('rejects an empty command', async () => {
    await expect(shellExecuteTool.execute({ command: '  ' }, ctx)).rejects.toThrow(/No command given/)
  })
})
