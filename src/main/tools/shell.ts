import { exec } from 'node:child_process'
import { looksLikePythonNotFound, pythonNotFoundHint, withWorkspaceVenv } from './python-env'
import { tidyRootStrays } from './workspace-layout'
import { diffSnapshots, snapshotWorkspace } from './workspace-snapshot'
import type { Tool } from './types'

const TIMEOUT_MS = 30_000
const MAX_BUFFER_BYTES = 1_000_000
const MAX_LISTED_MOVES = 20

/**
 * TASKS.md #156/#167: on Windows, enforce PowerShell rather than hoping Node's own default (`cmd.exe`)
 * happens to match what a model was told to target. Node's `exec()` `shell` option can't just be set to
 * `'powershell.exe'` — its docs are explicit that a custom Windows shell still needs to understand cmd.exe's
 * `/d /s /c` invocation flags, which PowerShell does not (it needs `-Command`/`-EncodedCommand` instead), so
 * that would silently break every call rather than fix anything. Instead, `exec()`'s own shell dispatch is
 * left alone (still `cmd.exe`, which reliably launches an arbitrary program) and the *command string itself*
 * becomes an explicit `powershell.exe -EncodedCommand <base64 UTF-16LE>` invocation — cmd.exe's only job
 * becomes launching that one program, never interpreting PowerShell syntax itself. `-EncodedCommand` (a
 * real, documented PowerShell flag, not a workaround) sidesteps all cmd/PowerShell quoting-escaping
 * differences entirely, which a naive `-Command "${command}"` string would not.
 */
export function windowsPowerShellCommand(command: string): string {
  const encoded = Buffer.from(command, 'utf16le').toString('base64')
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`
}

export const shellExecuteTool: Tool = {
  name: 'shell_execute',
  description:
    'Run a shell command. The process starts in the workspace root, but this is not a sandbox — ' +
    'a command can still read/write outside the workspace (e.g. via an absolute path or "cd .."). ' +
    "That's why every call requires human approval first. If the workspace has a `venv/`, it is " +
    'activated automatically: `python` and `pip` resolve to it (its packages are already installed).',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string', description: 'The shell command to run' } },
    required: ['command']
  },
  mutates: true,
  // Honors the orchestrator's cancellation signal for real (see
  // TASKS.md #93) — `exec`'s own `signal` option kills the child process
  // group on abort, same as its existing `timeout` option already does.
  cancellable: true,
  describe(input) {
    return `Run: ${String(input.command ?? '')}`
  },
  async execute(input, ctx, signal) {
    const command = String(input.command ?? '')
    if (!command.trim()) throw new Error('No command given.')

    const { env, active: venvActive } = withWorkspaceVenv(ctx.workspaceGuard.root, process.env)
    const effectiveCommand = process.platform === 'win32' ? windowsPowerShellCommand(command) : command

    const root = ctx.workspaceGuard.root
    const before = await snapshotWorkspace(root)
    const output = await new Promise<string>((resolvePromise, reject) => {
      // exec doesn't accept a `stdio` option (silently ignored — it always pipes all three streams itself
      // to buffer output for the callback) and leaves stdin as an open, unconnected pipe by default. There
      // is no user on the other end to answer an interactive prompt (`read`, a password prompt, a REPL), so
      // stdin is ended right away: such a command hits EOF immediately instead of hanging until the
      // timeout (TASKS.md #210).
      const child = exec(
        effectiveCommand,
        { cwd: ctx.workspaceGuard.root, env, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES, signal },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') {
            // Spawn-level failure (e.g. couldn't launch a shell at all), not a nonzero exit code.
            reject(error)
            return
          }
          const exitCode = typeof error?.code === 'number' ? error.code : 0
          const parts = [`exit code: ${exitCode}`]
          if (stdout.trim()) parts.push(`stdout:\n${stdout}`)
          if (stderr.trim()) parts.push(`stderr:\n${stderr}`)
          if (!venvActive && looksLikePythonNotFound(exitCode, stderr)) parts.push(pythonNotFoundHint())
          resolvePromise(parts.join('\n\n'))
        }
      )
      child.stdin?.end()
    })
    // TASKS #204: a command that scatters a bulk of new files in the workspace root is filed away like a python_run is
    // (see tidyRootStrays); the model is told the new paths. Only when the workspace could be scanned reliably.
    const diff = diffSnapshots(before, await snapshotWorkspace(root))
    const moved = diff.reliable ? await tidyRootStrays(root, diff.created) : []
    if (!moved.length) return output
    const listed = moved.slice(0, MAX_LISTED_MOVES).map((m) => `${m.from} -> ${m.to}`).join(', ')
    return `${output}\n\nMoved ${moved.length} file(s) the command left in the workspace root: ${listed}${moved.length > MAX_LISTED_MOVES ? ', ...' : ''}. Use the new paths, and put scratch files in tmp/ next time.`
  }
}
