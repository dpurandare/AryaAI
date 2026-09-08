import { execFile } from 'node:child_process'
import type { Tool } from './types'

const TIMEOUT_MS = 30_000
const MAX_BUFFER_BYTES = 1_000_000

/** Shells out to a cloud provider's own CLI — the tool doesn't manage cloud credentials itself, it assumes the CLI is already authenticated on this machine (aws configure / az login / gcloud auth login). */
function makeCliTool(binary: string, name: string, displayName: string): Tool {
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
      const args = Array.isArray(input.args) ? (input.args as unknown[]).map(String) : []
      return `Run: ${binary} ${args.join(' ')}`
    },
    async execute(input, ctx) {
      const args = Array.isArray(input.args) ? (input.args as unknown[]).map(String) : []

      return new Promise((resolvePromise, reject) => {
        execFile(
          binary,
          args,
          { cwd: ctx.workspaceGuard.root, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
          (error, stdout, stderr) => {
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
          }
        )
      })
    }
  }
}

export const awsCliTool = makeCliTool('aws', 'aws_cli', 'AWS')
export const azureCliTool = makeCliTool('az', 'azure_cli', 'Azure')
export const gcloudCliTool = makeCliTool('gcloud', 'gcloud_cli', 'Google Cloud')
