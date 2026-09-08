import { execFile } from 'node:child_process'
import type { Tool } from './types'

const TIMEOUT_MS = 30_000
const MAX_BUFFER_BYTES = 1_000_000

/** Runs a CLI binary and formats its result the same way for every CLI-wrapper tool (aws/az/gcloud/gh/git). */
export function runCliCommand(binary: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(binary, args, { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`"${binary}" is not installed (or not on PATH). Install it and try again.`))
        return
      }
      if (error && typeof (error as { code?: unknown }).code !== 'number') {
        reject(error)
        return
      }
      const exitCode = (error as { code?: number } | null)?.code ?? 0
      const parts = [`exit code: ${exitCode}`]
      if (stdout.trim()) parts.push(`stdout:\n${stdout}`)
      if (stderr.trim()) parts.push(`stderr:\n${stderr}`)
      resolvePromise(parts.join('\n\n'))
    })
  })
}

function argsFrom(input: Record<string, unknown>): string[] {
  return Array.isArray(input.args) ? (input.args as unknown[]).map(String) : []
}

/** Shells out to an already-authenticated external CLI — the tool doesn't manage credentials itself. */
export function makeCliTool(binary: string, name: string, displayName: string): Tool {
  return {
    name,
    description:
      `Run a ${displayName} CLI command via "${binary}". Assumes ${binary} is already installed and ` +
      `authenticated on this machine — this tool does not configure credentials.`,
    inputSchema: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: `Arguments to pass to ${binary}, e.g. ["s3", "ls"]`
        }
      },
      required: ['args']
    },
    mutates: true,
    describe(input) {
      return `Run: ${binary} ${argsFrom(input).join(' ')}`
    },
    async execute(input, ctx) {
      return runCliCommand(binary, argsFrom(input), ctx.workspaceGuard.root)
    }
  }
}
