import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import type { ToolContext } from './types'

const mockExecFile = vi.fn()

vi.mock('node:child_process', () => ({
  execFile: (...callArgs: unknown[]) => mockExecFile(...callArgs)
}))

const { awsCliTool, azureCliTool, gcloudCliTool } = await import('./cloud-cli')

// A real OS-native absolute path, not a hand-built one — see
// workspace-guard.test.ts for why a synthetic path like '/workspace'
// resolves differently on Windows (drive-relative) than POSIX.
const root = resolve(tmpdir(), 'sachiv-cloud-cli-root')
const ctx: ToolContext = { workspaceGuard: new WorkspaceGuard(root) }

function respondWith(exitCode: number | null, stdout: string, stderr: string, spawnError?: NodeJS.ErrnoException): void {
  mockExecFile.mockImplementation((_bin, _args, _opts, callback) => {
    if (spawnError) {
      callback(spawnError, '', '')
      return
    }
    const error = exitCode && exitCode !== 0 ? Object.assign(new Error('failed'), { code: exitCode }) : null
    callback(error, stdout, stderr)
  })
}

describe('cloud CLI tools', () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  it('all three are always mutating', () => {
    expect(awsCliTool.mutates).toBe(true)
    expect(azureCliTool.mutates).toBe(true)
    expect(gcloudCliTool.mutates).toBe(true)
  })

  it('describes the literal command line for each CLI', () => {
    expect(awsCliTool.describe?.({ args: ['s3', 'ls'] })).toBe('Run: aws s3 ls')
    expect(azureCliTool.describe?.({ args: ['account', 'show'] })).toBe('Run: az account show')
    expect(gcloudCliTool.describe?.({ args: ['config', 'list'] })).toBe('Run: gcloud config list')
  })

  it('invokes the right binary with args and cwd fixed to the workspace root', async () => {
    respondWith(0, 'ok', '')
    await awsCliTool.execute({ args: ['sts', 'get-caller-identity'] }, ctx)
    expect(mockExecFile).toHaveBeenCalledWith(
      'aws',
      ['sts', 'get-caller-identity'],
      expect.objectContaining({ cwd: root }),
      expect.any(Function)
    )
  })

  it('returns exit code and stdout on success', async () => {
    respondWith(0, 'hello\n', '')
    const result = await awsCliTool.execute({ args: ['s3', 'ls'] }, ctx)
    expect(result).toContain('exit code: 0')
    expect(result).toContain('stdout:\nhello')
  })

  it('returns a nonzero exit code and stderr', async () => {
    respondWith(2, '', 'access denied\n')
    const result = await azureCliTool.execute({ args: ['account', 'show'] }, ctx)
    expect(result).toContain('exit code: 2')
    expect(result).toContain('stderr:\naccess denied')
  })

  it('gives a clear error when the CLI is not installed', async () => {
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' }) as NodeJS.ErrnoException
    respondWith(0, '', '', enoent)
    await expect(gcloudCliTool.execute({ args: ['config', 'list'] }, ctx)).rejects.toThrow(
      /"gcloud" is not installed/
    )
  })
})
