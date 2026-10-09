import { describe, expect, it } from 'vitest'
import type { Message } from '@shared/protocol'
import { emptyDelegateCalls, isRestatement, lastDelegateReplies } from './restatement'

describe('isRestatement', () => {
  it('treats the same answer as a restatement, ignoring markdown and punctuation', () => {
    expect(isRestatement('There are **91 customers** in the Northwind database.', ['There are 91 customers in the Northwind database.'])).toBe(true)
  })

  it('treats a shorter paraphrase with list numbering and non-breaking hyphens as a restatement (real 9.3 / search cases)', () => {
    const reply = 'The test wiki has three pages. The listing gives only identifiers, not display titles or paths:\n1. `inverter-fault-runbook`\n2. `grid-connection-checklist`\n3. `site-commissioning-guide`'
    const mine = 'The test wiki has three pages:\n\n1. `inverter‑fault‑runbook`\n2. `grid-connection-checklist`\n3. `site-commissioning-guide`\n\nThe listing only returned these identifiers, with no display titles or paths.'
    expect(isRestatement(mine, [reply])).toBe(true)
  })

  it('keeps an answer that adds real content', () => {
    expect(
      isRestatement('There are 91 customers. Most of them are in Germany, France and the USA, and the top five account for over a third of sales.', [
        'There are 91 customers in the Northwind database.'
      ])
    ).toBe(false)
  })

  it('keeps an unrelated or empty text', () => {
    expect(isRestatement('Anything else?', ['There are 91 customers in the Northwind database.'])).toBe(false)
    expect(isRestatement('', ['x y'])).toBe(false)
    expect(isRestatement('There are 91 customers', [])).toBe(false)
  })
})

describe('lastDelegateReplies', () => {
  const call = (name: string): Message => ({ role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name, input: {} }] })
  const result = (content: string, isError = false): Message => ({ role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content, isError }] })

  it('returns the reply of a delegate that just answered', () => {
    expect(lastDelegateReplies([call('delegate_to_data'), result('91')])).toEqual(['91'])
  })

  it('returns nothing for the router\'s own tools, failed delegates, or a conversation that does not end in results', () => {
    expect(lastDelegateReplies([call('read_file'), result('x')])).toEqual([])
    expect(lastDelegateReplies([call('delegate_to_data'), result('boom', true)])).toEqual([])
    expect(lastDelegateReplies([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toEqual([])
    expect(lastDelegateReplies([])).toEqual([])
  })
})

describe('emptyDelegateCalls', () => {
  const call = (name: string): Message => ({ role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name, input: {} }] })
  const result = (content: string, isError: boolean): Message => ({ role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content, isError }] })

  it('names a delegate whose whole result is the empty placeholder', () => {
    expect(emptyDelegateCalls([call('delegate_to_data'), result('(no response)', true)])).toEqual(['delegate_to_data'])
  })

  it('ignores a delegate that produced something, or a failure that is not emptiness', () => {
    expect(emptyDelegateCalls([call('delegate_to_data'), result('(no response)\n\nFiles created or changed: a.txt', true)])).toEqual([])
    expect(emptyDelegateCalls([call('delegate_to_data'), result('connection refused', true)])).toEqual([])
    expect(emptyDelegateCalls([call('delegate_to_data'), result('91', false)])).toEqual([])
    expect(emptyDelegateCalls([call('read_file'), result('(no response)', true)])).toEqual([])
  })
})
