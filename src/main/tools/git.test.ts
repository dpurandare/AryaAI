import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import type { ToolContext } from './types'

const mockExecFile = vi.fn()

vi.mock('node:child_process', () => ({
  execFile: (...callArgs: unknown[]) => mockExecFile(...callArgs)
}))

const { gitExecTool } = await import('./git')

// A real OS-native absolute path, not a hand-built one — see
// workspace-guard.test.ts for why a synthetic path like '/workspace'
// resolves differently on Windows (drive-relative) than POSIX.
const root = resolve(tmpdir(), 'sachiv-git-root')
const ctx: ToolContext = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }

function respondWith(exitCode: number | null, stdout: string, stderr: string): void {
  mockExecFile.mockImplementation((_bin, _args, _opts, callback) => {
    const error = exitCode && exitCode !== 0 ? Object.assign(new Error('failed'), { code: exitCode }) : null
    callback(error, stdout, stderr)
  })
}

describe('git_exec', () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  it('describes the literal command line', () => {
    expect(gitExecTool.describe?.({ args: ['status'] })).toBe('Run: git status')
  })

  it('invokes git with args and cwd fixed to the workspace root', async () => {
    respondWith(0, 'ok', '')
    await gitExecTool.execute({ args: ['log', '--oneline', '-5'] }, ctx)
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['log', '--oneline', '-5'],
      expect.objectContaining({ cwd: root }),
      expect.any(Function)
    )
  })

  it.each(['status', 'diff', 'log', 'show', 'blame', 'describe', 'shortlog', 'ls-files', 'ls-tree', 'rev-parse', 'cat-file'])(
    'classifies "%s" as read-only (no confirmation)',
    (subcommand) => {
      const mutates = gitExecTool.mutates as (input: Record<string, unknown>) => boolean
      expect(mutates({ args: [subcommand] })).toBe(false)
    }
  )

  it.each(['commit', 'checkout', 'merge', 'push', 'reset', 'rebase', 'add', 'rm'])(
    'classifies "%s" as mutating',
    (subcommand) => {
      const mutates = gitExecTool.mutates as (input: Record<string, unknown>) => boolean
      expect(mutates({ args: [subcommand] })).toBe(true)
    }
  )

  it('treats branch/remote/tag/config/fetch as mutating by default (no args -> could still be a write elsewhere, so don\'t special-case them)', () => {
    const mutates = gitExecTool.mutates as (input: Record<string, unknown>) => boolean
    expect(mutates({ args: ['branch'] })).toBe(true)
    expect(mutates({ args: ['remote', '-v'] })).toBe(true)
    expect(mutates({ args: ['tag'] })).toBe(true)
    expect(mutates({ args: ['config', '--get', 'user.name'] })).toBe(true)
    expect(mutates({ args: ['fetch'] })).toBe(true)
  })

  it('gives a clear error when git is not installed', async () => {
    mockExecFile.mockImplementation((_bin, _args, _opts, callback) => {
      const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' })
      callback(enoent, '', '')
    })
    await expect(gitExecTool.execute({ args: ['status'] }, ctx)).rejects.toThrow(/"git" is not installed/)
  })

  it('returns exit code and stdout on success', async () => {
    respondWith(0, 'On branch main\n', '')
    const result = await gitExecTool.execute({ args: ['status'] }, ctx)
    expect(result).toContain('exit code: 0')
    expect(result).toContain('stdout:\nOn branch main')
  })
})
