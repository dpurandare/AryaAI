import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import { shellExecuteTool } from './shell'
import type { ToolContext } from './types'

// child_process.exec spawns the OS's default shell — bash/sh on macOS and
// Linux, cmd.exe on Windows — so command syntax genuinely differs (`;` vs
// `&` as a separator, no `pwd` builtin on cmd.exe). That's inherent to what
// the tool does, not a bug to paper over; the tests below pick the right
// syntax per platform. Caught live by this project's cross-platform CI: an
// earlier version of this file assumed bash syntax everywhere and failed on
// Windows.
const isWindows = process.platform === 'win32'

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
    const command = isWindows ? 'cd' : 'pwd'
    const result = await shellExecuteTool.execute({ command }, ctx)
    expect(result).toContain('exit code: 0')
    // Match by the temp dir's own basename rather than the full path — on
    // macOS /tmp is a symlink to /private/tmp and pwd may report either.
    expect(result).toContain(basename(root))
  })

  it('captures stdout', async () => {
    const result = await shellExecuteTool.execute({ command: 'echo hello' }, ctx)
    expect(result).toContain('exit code: 0')
    expect(result).toContain('stdout:\nhello')
  })

  it('captures a nonzero exit code and stderr', async () => {
    const command = isWindows ? 'echo oops 1>&2 & exit 3' : 'echo oops 1>&2; exit 3'
    const result = await shellExecuteTool.execute({ command }, ctx)
    expect(result).toContain('exit code: 3')
    expect(result).toContain('stderr:\noops')
  })

  it('can actually write a file into the workspace', async () => {
    await shellExecuteTool.execute({ command: 'echo written > out.txt' }, ctx)
    const content = await readFile(join(root, 'out.txt'), 'utf-8')
    // cmd.exe's `echo` keeps the trailing CRLF; bash's adds a single LF.
    expect(content.trim()).toBe('written')
  })

  it('rejects an empty command', async () => {
    await expect(shellExecuteTool.execute({ command: '  ' }, ctx)).rejects.toThrow(/No command given/)
  })
})
