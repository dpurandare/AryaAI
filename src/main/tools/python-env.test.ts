import { describe, expect, it } from 'vitest'
import { looksLikePythonNotFound, pythonNotFoundHint, withWorkspaceVenv, workspaceVenvBinDir } from './python-env'

const posixExists = (p: string) => p === '/ws/venv/bin/python'
const winExists = (p: string) => p === 'C:\\ws\\venv\\Scripts\\python.exe'

describe('workspaceVenvBinDir', () => {
  it('finds the venv bin folder on POSIX when it holds a python', () => {
    expect(workspaceVenvBinDir('/ws', { platform: 'linux', exists: posixExists })).toBe('/ws/venv/bin')
  })

  it('finds Scripts\\python.exe on Windows', () => {
    expect(workspaceVenvBinDir('C:\\ws', { platform: 'win32', exists: winExists })).toBe('C:\\ws\\venv\\Scripts')
  })

  it('ignores an empty or broken venv/ folder that has no python in it', () => {
    expect(workspaceVenvBinDir('/ws', { platform: 'linux', exists: () => false })).toBeUndefined()
  })
})

describe('withWorkspaceVenv', () => {
  it('puts the venv first on PATH, sets VIRTUAL_ENV and clears PYTHONHOME, leaving the input untouched', () => {
    const base = { PATH: '/usr/bin:/bin', PYTHONHOME: '/somewhere', HOME: '/h' }
    const { env, active } = withWorkspaceVenv('/ws', base, { platform: 'linux', exists: posixExists })
    expect(active).toBe(true)
    expect(env.PATH).toBe('/ws/venv/bin:/usr/bin:/bin')
    expect(env.VIRTUAL_ENV).toBe('/ws/venv')
    expect(env.PYTHONHOME).toBeUndefined()
    expect(env.HOME).toBe('/h')
    expect(base).toEqual({ PATH: '/usr/bin:/bin', PYTHONHOME: '/somewhere', HOME: '/h' })
  })

  it('respects Windows` differently-cased Path key and semicolon delimiter', () => {
    const { env } = withWorkspaceVenv('C:\\ws', { Path: 'C:\\Windows' }, { platform: 'win32', exists: winExists })
    expect(env.Path).toBe('C:\\ws\\venv\\Scripts;C:\\Windows')
    expect(env.PATH).toBeUndefined()
  })

  it('returns the environment unchanged and inactive when there is no venv', () => {
    const base = { PATH: '/usr/bin' }
    const { env, active } = withWorkspaceVenv('/ws', base, { platform: 'linux', exists: () => false })
    expect(active).toBe(false)
    expect(env).toBe(base)
  })
})

describe('looksLikePythonNotFound / pythonNotFoundHint', () => {
  it('recognises the real failure seen live (dash) and bash / cmd.exe wordings', () => {
    expect(looksLikePythonNotFound(127, '/bin/sh: 1: python: not found')).toBe(true)
    expect(looksLikePythonNotFound(127, 'bash: python: command not found')).toBe(true)
    expect(looksLikePythonNotFound(9009, "'python' is not recognized as an internal or external command")).toBe(true)
  })

  it('does not fire for other failures or other missing commands', () => {
    expect(looksLikePythonNotFound(1, 'python: not found')).toBe(false)
    expect(looksLikePythonNotFound(127, '/bin/sh: 1: foo: not found')).toBe(false)
  })

  it('tells the model that running Python IS possible and how to create the venv, per platform', () => {
    expect(pythonNotFoundHint('linux')).toContain('python3 -m venv venv')
    expect(pythonNotFoundHint('linux')).toContain('IS possible')
    expect(pythonNotFoundHint('win32')).toContain('py -m venv venv')
  })
})
