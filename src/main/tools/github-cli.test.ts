import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import type { ToolContext } from './types'

const mockExecFile = vi.fn()

vi.mock('node:child_process', () => ({
  execFile: (...callArgs: unknown[]) => mockExecFile(...callArgs)
}))

const { githubCliTool } = await import('./github-cli')

// A real OS-native absolute path, not a hand-built one — see
// workspace-guard.test.ts for why a synthetic path like '/workspace'
// resolves differently on Windows (drive-relative) than POSIX.
const root = resolve(tmpdir(), 'sachiv-github-cli-root')
const ctx: ToolContext = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }

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

describe('github_cli', () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  it('is always mutating', () => {
    expect(githubCliTool.mutates).toBe(true)
  })

  it('describes the literal command line', () => {
    expect(githubCliTool.describe?.({ args: ['pr', 'list'] })).toBe('Run: gh pr list')
  })

  it('invokes gh with args and cwd fixed to the workspace root', async () => {
    respondWith(0, 'ok', '')
    await githubCliTool.execute({ args: ['issue', 'list'] }, ctx)
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'list'],
      expect.objectContaining({ cwd: root }),
      expect.any(Function)
    )
  })

  it('returns exit code and stdout on success', async () => {
    respondWith(0, 'hello\n', '')
    const result = await githubCliTool.execute({ args: ['pr', 'view'] }, ctx)
    expect(result).toContain('exit code: 0')
    expect(result).toContain('stdout:\nhello')
  })

  it('gives a clear error when gh is not installed', async () => {
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' }) as NodeJS.ErrnoException
    respondWith(0, '', '', enoent)
    await expect(githubCliTool.execute({ args: ['pr', 'list'] }, ctx)).rejects.toThrow(/"gh" is not installed/)
  })
})
