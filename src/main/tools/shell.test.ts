import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import { shellExecuteTool, windowsPowerShellCommand } from './shell'
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
    // TASKS.md #156/#167: on Windows this now runs through PowerShell (windowsPowerShellCommand below),
    // not cmd.exe directly — bare `cd` prints the current dir in cmd.exe but is silent in PowerShell, so
    // (Get-Location).Path is the real PowerShell equivalent, not a like-for-like port of the old command.
    const command = isWindows ? '(Get-Location).Path' : 'pwd'
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
    // TASKS.md #156/#167: `&` as a statement separator is cmd.exe syntax — PowerShell uses `;`, same as
    // the POSIX branch, now that Windows commands run through PowerShell rather than cmd.exe directly.
    // Confirmed live on Windows CI (first real run after the design_change -> main merge, since this
    // workflow never triggers on design_change itself): `1>&2` is bash/cmd redirection syntax, not valid
    // PowerShell ("the '1>&2' operator is reserved for future use") — PowerShell writes directly to the
    // real stderr stream instead, via [Console]::Error.
    const command = isWindows ? "[Console]::Error.WriteLine('oops'); exit 3" : 'echo oops 1>&2; exit 3'
    const result = await shellExecuteTool.execute({ command }, ctx)
    expect(result).toContain('exit code: 3')
    expect(result).toContain('stderr:\noops')
  })

  it('can actually write a file into the workspace', async () => {
    await shellExecuteTool.execute({ command: 'echo written > out.txt' }, ctx)
    // Confirmed live on Windows CI: PowerShell's `>` redirect (unlike cmd.exe's) writes UTF-16LE with a
    // BOM by default — a real platform quirk of Windows PowerShell 5.1 (`powershell.exe`, not pwsh.exe),
    // not something this tool controls (see TASKS #210/#211's Windows-CI-gap note for the decision not
    // to blind-fix PowerShell's own encoding default without a way to verify it beyond CI iteration).
    const content = await readFile(join(root, 'out.txt'), isWindows ? 'utf16le' : 'utf-8')
    // cmd.exe's `echo` keeps the trailing CRLF; bash's adds a single LF; strip a possible UTF-16 BOM.
    expect(content.replace(/^﻿/, '').trim()).toBe('written')
  })

  it('rejects an empty command', async () => {
    await expect(shellExecuteTool.execute({ command: '  ' }, ctx)).rejects.toThrow(/No command given/)
  })

  it('is declared cancellable (TASKS.md #93)', () => {
    expect(shellExecuteTool.cancellable).toBe(true)
  })

  // TASKS.md #210: stdin is explicitly closed, so a command that tries to read it (an interactive
  // prompt, a `read`, a password prompt) hits EOF immediately instead of hanging until TIMEOUT_MS.
  // POSIX-only: Windows's equivalent (PowerShell's Read-Host) talks to the console host rather than
  // the piped stdin handle this fix closes, so it is not exercised the same way here.
  it.skipIf(isWindows)('fails fast on a command that reads stdin, instead of hanging until the timeout', async () => {
    const start = Date.now()
    // `read`'s own exit code (1 on EOF) is discarded by `;`, so what actually proves stdin was
    // closed — rather than just not written to — is that `read` returns immediately with nothing,
    // not that it hangs until TIMEOUT_MS then reports a timeout.
    const result = await shellExecuteTool.execute({ command: 'read x; echo "got: [$x]"' }, ctx)
    expect(Date.now() - start).toBeLessThan(5_000)
    expect(result).toContain('got: []')
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

// TASKS.md #156/#167: the encoding logic itself, verifiable on any platform (unlike the shell_execute tests
// above, whose Windows branches only ever actually run on real Windows CI — never on this Linux dev
// machine, so those depend on the CI run to confirm the PowerShell syntax choices are right; this test
// instead verifies the one part that CAN be checked with certainty from anywhere: that the transformation
// itself round-trips the exact original command, with no quoting/escaping loss).
describe('windowsPowerShellCommand (#156/#167)', () => {
  it('base64-UTF16LE-encodes the command such that decoding it recovers the exact original text', () => {
    const command = 'Write-Host "hello"; Get-ChildItem'
    const wrapped = windowsPowerShellCommand(command)
    expect(wrapped).toMatch(/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /)
    const encoded = wrapped.replace(/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /, '')
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(command)
  })

  it('round-trips a command containing characters that would need escaping in a naive quoted invocation', () => {
    const command = String.raw`echo "it's a \"test\"" | Select-String 'pattern'`
    const wrapped = windowsPowerShellCommand(command)
    const encoded = wrapped.replace(/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /, '')
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(command)
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

  // TASKS #204: the same sweep python_run has. File-creating commands are written in POSIX shell syntax here.
  describe.skipIf(isWindows)('files a command leaves loose in the workspace root', () => {
    it('files a bulk of new loose files by kind, and says where they went', async () => {
      const result = await shellExecuteTool.execute({ command: 'for i in 1 2 3 4; do echo x > page_$i.png; done; echo x > notes.csv' }, ctx)
      expect(result).toContain('exit code: 0')
      expect(result).toContain('Moved 5 file(s) the command left in the workspace root')
      expect(result).toContain('page_1.png -> resources/page_1.png')
      expect(result).toContain('notes.csv -> tmp/notes.csv')
      expect(existsSync(join(root, 'page_1.png'))).toBe(false)
      expect(existsSync(join(root, 'resources', 'page_4.png'))).toBe(true)
      expect(existsSync(join(root, 'tmp', 'notes.csv'))).toBe(true)
    })

    it('leaves one or two new files alone (they are normally the deliverable), and adds no note', async () => {
      const result = await shellExecuteTool.execute({ command: 'echo x > data.json; echo y > chart.png' }, ctx)
      expect(result).not.toContain('Moved ')
      expect(existsSync(join(root, 'data.json'))).toBe(true)
      expect(existsSync(join(root, 'chart.png'))).toBe(true)
    })

    it('never touches files that already existed, files in folders, or hidden files', async () => {
      for (const n of [1, 2, 3, 4]) await writeFile(join(root, `old_${n}.png`), 'old')
      const result = await shellExecuteTool.execute({ command: 'mkdir out; for i in 1 2 3 4 5; do echo x > out/f$i.png; echo x > .h$i; done' }, ctx)
      expect(result).not.toContain('Moved ')
      expect(existsSync(join(root, 'old_1.png'))).toBe(true)
      expect(existsSync(join(root, 'out', 'f1.png'))).toBe(true)
      expect(existsSync(join(root, '.h1'))).toBe(true)
    })
  })
})

