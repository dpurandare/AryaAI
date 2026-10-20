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

  // TASKS #221: realistic read-only calls. The tool passes args through verbatim (no --output handling of its own) and
  // returns the CLI's stdout as text, so a test checks the exact argv and that the JSON the CLI printed survives intact.
  // Only read-only commands appear here, and execFile is mocked: nothing real runs.
  describe('typical read-only operations (mocked CLI)', () => {
    const stdoutJson = (result: string): unknown => JSON.parse(result.split('stdout:\n')[1].split('\n\nstderr:')[0])

    const cases = [
      {
        label: 'aws sts get-caller-identity',
        tool: awsCliTool,
        binary: 'aws',
        args: ['sts', 'get-caller-identity', '--output', 'json'],
        stdout: '{\n    "UserId": "AIDAEXAMPLE",\n    "Account": "123456789012",\n    "Arn": "arn:aws:iam::123456789012:user/dev"\n}\n',
        expected: { UserId: 'AIDAEXAMPLE', Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/dev' }
      },
      {
        label: 'aws s3api list-buckets',
        tool: awsCliTool,
        binary: 'aws',
        args: ['s3api', 'list-buckets', '--output', 'json'],
        stdout: '{"Buckets":[{"Name":"reports","CreationDate":"2026-01-02T03:04:05+00:00"}],"Owner":{"ID":"abc"}}',
        expected: { Buckets: [{ Name: 'reports', CreationDate: '2026-01-02T03:04:05+00:00' }], Owner: { ID: 'abc' } }
      },
      {
        label: 'az account show',
        tool: azureCliTool,
        binary: 'az',
        args: ['account', 'show', '--output', 'json'],
        stdout: '{"id":"00000000-0000-0000-0000-000000000000","name":"Dev subscription","state":"Enabled"}',
        expected: { id: '00000000-0000-0000-0000-000000000000', name: 'Dev subscription', state: 'Enabled' }
      },
      {
        label: 'az group list',
        tool: azureCliTool,
        binary: 'az',
        args: ['group', 'list', '--output', 'json'],
        stdout: '[{"name":"rg-dev","location":"westeurope"},{"name":"rg-test","location":"northeurope"}]',
        expected: [
          { name: 'rg-dev', location: 'westeurope' },
          { name: 'rg-test', location: 'northeurope' }
        ]
      },
      {
        label: 'gcloud config list',
        tool: gcloudCliTool,
        binary: 'gcloud',
        args: ['config', 'list', '--format=json'],
        stdout: '{"core":{"account":"dev@example.com","project":"my-project"}}',
        expected: { core: { account: 'dev@example.com', project: 'my-project' } }
      },
      {
        label: 'gcloud projects list',
        tool: gcloudCliTool,
        binary: 'gcloud',
        args: ['projects', 'list', '--format=json'],
        stdout: '[{"projectId":"my-project","name":"My Project","lifecycleState":"ACTIVE"}]',
        expected: [{ projectId: 'my-project', name: 'My Project', lifecycleState: 'ACTIVE' }]
      }
    ]

    for (const c of cases) {
      it(`${c.label}: exact argv, no shell, JSON output returned intact`, async () => {
        respondWith(0, c.stdout, '')
        const result = await c.tool.execute({ args: c.args }, ctx)
        expect(mockExecFile).toHaveBeenCalledTimes(1)
        const [binary, argv, options] = mockExecFile.mock.calls[0]
        expect(binary).toBe(c.binary)
        expect(argv).toEqual(c.args)
        // Arguments go to execFile as an array, never joined into a shell string, and with a timeout and an output cap.
        expect(options).toMatchObject({ cwd: root, timeout: 30_000, maxBuffer: 1_000_000 })
        expect(options).not.toHaveProperty('shell')
        expect(result.startsWith('exit code: 0')).toBe(true)
        expect(stdoutJson(result)).toEqual(c.expected)
      })
    }

    it('an unauthenticated CLI comes back as a nonzero exit code with its stderr, not as a thrown error', async () => {
      respondWith(255, '', 'Unable to locate credentials. You can configure credentials by running "aws configure".\n')
      const aws = await awsCliTool.execute({ args: ['sts', 'get-caller-identity'] }, ctx)
      expect(aws).toContain('exit code: 255')
      expect(aws).toContain('Unable to locate credentials')
      expect(aws).not.toContain('stdout:')

      respondWith(1, '', "ERROR: Please run 'az login' to setup account.\n")
      const az = await azureCliTool.execute({ args: ['account', 'show'] }, ctx)
      expect(az).toContain('exit code: 1')
      expect(az).toContain("Please run 'az login'")

      respondWith(1, '', 'ERROR: (gcloud.projects.list) You do not currently have an active account selected.\n')
      const gcloud = await gcloudCliTool.execute({ args: ['projects', 'list'] }, ctx)
      expect(gcloud).toContain('exit code: 1')
      expect(gcloud).toContain('active account selected')
    })

    it('shows stdout and stderr together when a CLI writes warnings next to its output', async () => {
      respondWith(0, '[]\n', 'WARNING: a newer version is available\n')
      const result = await azureCliTool.execute({ args: ['group', 'list'] }, ctx)
      expect(result).toContain('stdout:\n[]')
      expect(result).toContain('stderr:\nWARNING: a newer version is available')
    })

    it('a timeout or output-cap kill (an error without a numeric exit code) is rethrown, not reported as success', async () => {
      const killed = Object.assign(new Error('Command failed: maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
      mockExecFile.mockImplementation((_b, _a, _o, callback) => callback(killed, '', ''))
      await expect(awsCliTool.execute({ args: ['s3api', 'list-objects-v2', '--bucket', 'huge'] }, ctx)).rejects.toThrow(/maxBuffer/)
    })

    it('arguments that are not strings are passed as strings, and a missing args list runs the bare CLI', async () => {
      respondWith(0, '', '')
      await gcloudCliTool.execute({ args: ['projects', 'list', '--limit', 5] }, ctx)
      expect(mockExecFile.mock.calls[0][1]).toEqual(['projects', 'list', '--limit', '5'])
      await gcloudCliTool.execute({}, ctx)
      expect(mockExecFile.mock.calls[1][1]).toEqual([])
    })
  })
})
