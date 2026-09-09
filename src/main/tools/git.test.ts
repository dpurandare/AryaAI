import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import type { ToolContext } from './types'

const mockExecFile = vi.fn()

vi.mock('node:child_process', () => ({
  execFile: (...callArgs: unknown[]) => mockExecFile(...callArgs)
}))

const { gitExecTool, gitCloneRepoTool } = await import('./git')

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

  it('rejects "clone" and points at git_clone_repo instead of running it', async () => {
    await expect(gitExecTool.execute({ args: ['clone', 'https://example.com/repo.git'] }, ctx)).rejects.toThrow(
      /git_clone_repo/
    )
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})

describe('git_clone_repo', () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  it('is always mutating (no per-input classification)', () => {
    expect(gitCloneRepoTool.mutates).toBe(true)
  })

  it('describes the URL being cloned', () => {
    expect(gitCloneRepoTool.describe?.({ url: 'https://example.com/repo.git' })).toContain(
      'https://example.com/repo.git'
    )
  })

  it('clones into a fresh folder under .sachiv-clones, with no destination input accepted', async () => {
    respondWith(0, 'Cloning...\n', '')
    const result = await gitCloneRepoTool.execute({ url: 'https://example.com/my-repo.git' }, ctx)

    expect(mockExecFile).toHaveBeenCalledTimes(1)
    const [bin, args, opts] = mockExecFile.mock.calls[0] as [string, string[], { cwd: string }]
    expect(bin).toBe('git')
    expect(args[0]).toBe('clone')
    expect(args).toContain('--depth')
    expect(args).toContain('https://example.com/my-repo.git')
    expect(opts.cwd).toBe(root)

    const dest = args.at(-1) as string
    expect(dest.startsWith(resolve(root, '.sachiv-clones'))).toBe(true)
    expect(dest).toContain('my-repo')
    expect(result).toContain('.sachiv-clones/')
  })

  it('two clones of the same URL land in two different folders', async () => {
    respondWith(0, 'Cloning...\n', '')
    await gitCloneRepoTool.execute({ url: 'https://example.com/same-repo.git' }, ctx)
    const firstDest = (mockExecFile.mock.calls[0] as [string, string[]])[1].at(-1)

    mockExecFile.mockReset()
    respondWith(0, 'Cloning...\n', '')
    await gitCloneRepoTool.execute({ url: 'https://example.com/same-repo.git' }, ctx)
    const secondDest = (mockExecFile.mock.calls[0] as [string, string[]])[1].at(-1)

    expect(firstDest).not.toBe(secondDest)
  })

  it('passes --branch when a ref is given', async () => {
    respondWith(0, 'Cloning...\n', '')
    await gitCloneRepoTool.execute({ url: 'https://example.com/repo.git', ref: 'develop' }, ctx)
    const args = (mockExecFile.mock.calls[0] as [string, string[]])[1]
    expect(args).toContain('--branch')
    expect(args).toContain('develop')
  })

  it('rejects a missing URL without ever shelling out', async () => {
    await expect(gitCloneRepoTool.execute({}, ctx)).rejects.toThrow(/repository URL/)
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})
