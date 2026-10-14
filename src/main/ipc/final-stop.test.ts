import { describe, expect, it } from 'vitest'
import { isFinalStop } from './final-stop'

describe('isFinalStop', () => {
  it('is true for an untagged stop that is not a tool-use pause', () => {
    expect(isFinalStop({ type: 'message_stop', stopReason: 'end_turn' })).toBe(true)
    expect(isFinalStop({ type: 'message_stop', stopReason: 'aborted' })).toBe(true)
    expect(isFinalStop({ type: 'message_stop', stopReason: 'max_tokens' })).toBe(true)
  })

  it('is false for a tool-use pause, a nested specialist round, and other events', () => {
    expect(isFinalStop({ type: 'message_stop', stopReason: 'tool_use' })).toBe(false)
    expect(isFinalStop({ type: 'message_stop', stopReason: 'end_turn', agentRole: 'coding' })).toBe(false)
    expect(isFinalStop({ type: 'usage', inputTokens: 1, outputTokens: 1 })).toBe(false)
  })
})
