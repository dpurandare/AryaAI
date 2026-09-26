import { beforeEach, describe, expect, it } from 'vitest'
import { setDbPath } from './index'
import { getToolUsage, logToolUse } from './tool-usage-log'

describe('tool usage log', () => {
  beforeEach(() => {
    setDbPath(':memory:')
  })

  it('starts empty', () => {
    expect(getToolUsage()).toEqual([])
  })

  it('counts calls per tool, separating the router\'s own calls from specialists\', most-used first', () => {
    logToolUse({ tool: 'shell_execute', agentRole: 'router' })
    logToolUse({ tool: 'shell_execute', agentRole: 'router' })
    logToolUse({ tool: 'shell_execute', agentRole: 'coding' })
    logToolUse({ tool: 'db_execute_sql', agentRole: 'data' })
    expect(getToolUsage()).toEqual([
      { tool: 'shell_execute', calls: 3, routerCalls: 2 },
      { tool: 'db_execute_sql', calls: 1, routerCalls: 0 }
    ])
  })

  it('can be limited to recent calls', () => {
    logToolUse({ tool: 'read_file', agentRole: 'router' })
    expect(getToolUsage(Date.now() + 60_000)).toEqual([])
  })

  it('never throws, even when the database is unusable', () => {
    setDbPath(':memory:')
    expect(() => logToolUse({ tool: 'x', agentRole: 'router' })).not.toThrow()
  })
})
