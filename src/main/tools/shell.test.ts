import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
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

  it('is declared cancellable (TASKS.md #93)', () => {
    expect(shellExecuteTool.cancellable).toBe(true)
  })

  it('actually kills the running process when the signal aborts, instead of letting it run to completion', async () => {
    const controller = new AbortController()
    const command = isWindows ? 'ping -n 10 127.0.0.1 > out.txt' : 'sleep 5 && echo done > out.txt'
    const runPromise = shellExecuteTool.execute({ command }, ctx, controller.signal)
    controller.abort()
    await expect(runPromise).rejects.toThrow()
    // The command was really killed, not just abandoned by the caller — its
    // own side effect (the file it would have written after sleeping) never
    // happens, proving the child process itself stopped.
    await expect(readFile(join(root, 'out.txt'), 'utf-8')).rejects.toThrow()
  })
})

// Hard-wired workspace venv (found live: the agent ran `python`, got exit 127, and gave up although the workspace had a working venv). Uses a fake `venv/bin/python` shell script, so POSIX only — the platform branches are covered by python-env.test.ts.
describe.skipIf(isWindows)('shell_execute + workspace venv', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-shell-venv-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function makeVenv(): Promise<void> {
    await mkdir(join(root, 'venv', 'bin'), { recursive: true })
    const py = join(root, 'venv', 'bin', 'python')
    await writeFile(py, '#!/bin/sh\necho "VENV_PYTHON $@"\n')
    await chmod(py, 0o755)
  }

  it('resolves a bare `python` to the workspace venv, without the model asking for it', async () => {
    await makeVenv()
    const result = await shellExecuteTool.execute({ command: 'python chart.py' }, ctx)
    expect(result).toContain('exit code: 0')
    expect(result).toContain('VENV_PYTHON chart.py')
  })

  it('exposes VIRTUAL_ENV and puts the venv first on PATH for every command', async () => {
    await makeVenv()
    const result = await shellExecuteTool.execute({ command: 'echo "$VIRTUAL_ENV|${PATH%%:*}"' }, ctx)
    expect(result).toContain(`${join(root, 'venv')}|${join(root, 'venv', 'bin')}`)
  })

  it('leaves the environment alone when the workspace has no venv', async () => {
    const result = await shellExecuteTool.execute({ command: 'echo "$PATH"' }, ctx)
    expect(result).not.toContain(join(root, 'venv'))
  })

  it('points at Settings > Runtime when python is missing and there is no venv to fall back on', async () => {
    const result = await shellExecuteTool.execute({ command: 'python-does-not-exist chart.py' }, ctx)
    expect(result).toContain('exit code: 127')
    expect(result).toContain('hint:')
    expect(result).toContain('Settings > Runtime')
  })

  it('does not add the hint for an unrelated missing command', async () => {
    const result = await shellExecuteTool.execute({ command: 'definitely-not-a-command' }, ctx)
    expect(result).not.toContain('hint:')
  })
})
