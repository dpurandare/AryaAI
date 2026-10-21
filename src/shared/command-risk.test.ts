import { describe, expect, it } from 'vitest'
import { commandWarning, isShellLikeTool } from './command-risk'

describe('commandWarning (TASKS #234)', () => {
  it('warns that a protected location is mentioned', () => {
    expect(commandWarning('shell_execute', { command: 'cat /etc/hostname' })?.level).toBe('protected')
    expect(commandWarning('shell_execute', { command: 'cat ~/.ssh/id_rsa' })?.level).toBe('protected')
    expect(commandWarning('python_run', { code: "open('C:\\\\Users\\\\me\\\\.aws\\\\credentials')" })?.level).toBe('protected')
    expect(commandWarning('github_cli', { args: ['api', '/System/Library'] })?.level).toBe('protected')
  })
  it('warns softly about paths that may be outside the workspace', () => {
    for (const command of ['ls ~/Downloads', 'cat ../x.txt', 'ls /tmp', 'cd $HOME && ls', 'dir C:/Users']) {
      expect(commandWarning('shell_execute', { command })?.level).toBe('outside')
    }
  })
  it('stays quiet for ordinary workspace commands and for tools that are not command runners', () => {
    expect(commandWarning('shell_execute', { command: 'ls -la && python scripts/a.py data/x.csv' })).toBeNull()
    expect(commandWarning('git_exec', { args: ['status'] })).toBeNull()
    expect(commandWarning('read_file', { path: '/etc/hostname' })).toBeNull()
    expect(commandWarning('shell_execute', { command: 'echo /etcetera' })?.level).not.toBe('protected')
  })
  it('knows which tools are command runners', () => {
    expect(isShellLikeTool('shell_execute')).toBe(true)
    expect(isShellLikeTool('write_file')).toBe(false)
  })
})
