import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import type { ToolContext } from './types'
import { buildEnvironment, createEnvironmentTool } from './environment'

describe('get_environment', () => {
  const base = {
    workspaceRoot: '/Users/me/Documents/Sachivji Workspace',
    platform: 'darwin' as const,
    osRelease: '25.0.0',
    architecture: 'arm64',
    home: '/Users/me',
    exists: (p: string) => p.endsWith('Desktop') || p.endsWith('Downloads'),
    now: new Date('2026-10-09T16:30:00Z'),
    timeZone: 'Asia/Kolkata'
  }

  it('states the workspace path and what each of its folders is for', () => {
    const text = buildEnvironment(base)
    expect(text).toContain('Workspace: /Users/me/Documents/Sachivji Workspace')
    for (const folder of ['code/', 'documents/', 'resources/', 'exports/', 'tmp/', 'templates/']) expect(text).toContain(`- ${folder}`)
    expect(text).toContain('goes in the workspace')
    // TASKS #204: scripts and shell commands are told that a bare file name lands in the root.
    expect(text).toContain('a bare file name lands in the workspace root')
  })

  it('says which conventional folders do not exist yet, so none is reported as present when it is not (TASKS #238)', () => {
    const text = buildEnvironment({ ...base, workspaceExists: (rel) => ['code', 'documents'].includes(rel) })
    expect(text).toContain('- code/ : scripts and source you write\n')
    expect(text).toMatch(/- templates\/ : the user's own templates, read as input \(not created yet\)/)
    expect(text).toMatch(/- exports\/ : .*\(not created yet\)/)
    expect(text).not.toMatch(/- documents\/ : .*not created yet/)
  })

  it('names the OS, shell, home and the common folders that exist, and the date in the time zone', () => {
    const text = buildEnvironment(base)
    expect(text).toContain('OS: macOS 25.0.0 (arm64)')
    expect(text).toContain('Shell: bash')
    expect(text).toContain('Home folder: /Users/me')
    expect(text).toContain('Common folders: /Users/me/Desktop, /Users/me/Downloads')
    expect(text).not.toContain('/Users/me/Documents,')
    expect(text).toMatch(/Now: .*2026.*\(Asia\/Kolkata\)/)
    expect(buildEnvironment({ ...base, platform: 'win32' })).toContain('Shell: PowerShell')
  })

  it('reports Python and the folders allowed outside the workspace', () => {
    const text = buildEnvironment({
      ...base,
      runtime: { status: 'ready', packages: 'installed', message: '', pythonVersion: '3.12.4', root: base.workspaceRoot },
      allowedFolders: ['/Users/me/Work']
    })
    expect(text).toContain('Python: available 3.12.4')
    expect(text).toContain('Folders the user allowed for good: /Users/me/Work')
    expect(buildEnvironment({ ...base, runtime: { status: 'disabled', packages: 'none', message: 'Turned off by the user', root: '' } })).toContain('Python: disabled — Turned off by the user')
  })

  describe('as a tool', () => {
    let root: string
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'sachiv-env-'))
    })
    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    it('reads the workspace from the call, needs no confirmation and no input', async () => {
      const tool = createEnvironmentTool({ appVersion: () => '9.9.9' })
      expect(tool.mutates).toBe(false)
      const ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 's' } as ToolContext
      const text = await tool.execute({}, ctx)
      expect(text).toContain(`Workspace: ${ctx.workspaceGuard.root}`)
      expect(text).toContain('Sachivji 9.9.9')
    })
  })
})
