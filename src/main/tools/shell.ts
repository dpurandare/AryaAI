import { exec } from 'node:child_process'
import type { Tool } from './types'

const TIMEOUT_MS = 30_000
const MAX_BUFFER_BYTES = 1_000_000

export const shellExecuteTool: Tool = {
  name: 'shell_execute',
  description:
    'Run a shell command. The process starts in the workspace root, but this is not a sandbox — ' +
    'a command can still read/write outside the workspace (e.g. via an absolute path or "cd .."). ' +
    "That's why every call requires human approval first.",
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string', description: 'The shell command to run' } },
    required: ['command']
  },
  mutates: true,
  describe(input) {
    return `Run: ${String(input.command ?? '')}`
  },
  async execute(input, ctx) {
    const command = String(input.command ?? '')
    if (!command.trim()) throw new Error('No command given.')

    return new Promise((resolvePromise, reject) => {
      exec(
        command,
        { cwd: ctx.workspaceGuard.root, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') {
            // Spawn-level failure (e.g. couldn't launch a shell at all), not a nonzero exit code.
            reject(error)
            return
          }
          const exitCode = error?.code ?? 0
          const parts = [`exit code: ${exitCode}`]
          if (stdout.trim()) parts.push(`stdout:\n${stdout}`)
          if (stderr.trim()) parts.push(`stderr:\n${stderr}`)
          resolvePromise(parts.join('\n\n'))
        }
      )
    })
  }
}
