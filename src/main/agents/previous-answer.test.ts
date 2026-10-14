import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@shared/protocol'
import { previousAnswerText } from './previous-answer'

const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text', text }] as ContentBlock[] })
const assistant = (...content: ContentBlock[]) => ({ role: 'assistant' as const, content })
const toolResult = { role: 'user' as const, content: [{ type: 'tool_result', toolUseId: 'x', content: 'r', isError: false }] as ContentBlock[] }

describe('previousAnswerText', () => {
  it('returns the last answer before the current request, ignoring this turn\'s own rounds', () => {
    const messages = [
      user('describe it'),
      assistant({ type: 'tool_use', id: 'x', name: 'db_introspect_schema', input: {} }),
      toolResult,
      assistant({ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'THE FULL ANSWER' }),
      user('make a Word doc of this'),
      assistant({ type: 'text', text: 'Sure, creating it' }),
      assistant({ type: 'tool_use', id: 'y', name: 'office_create_document', input: {} })
    ]
    expect(previousAnswerText(messages)).toBe('THE FULL ANSWER')
  })

  it('is undefined when nothing was answered yet', () => {
    expect(previousAnswerText([user('make a doc')])).toBeUndefined()
    expect(previousAnswerText([])).toBeUndefined()
  })

  it('does not take a plan step result for the request: a step\'s own draft reply is not "the previous answer"', () => {
    const messages = [
      user('find the top 5 customers and write them into a Word document'),
      assistant({ type: 'text', text: "Table… I'm unable to create a Word document. [handoff: out_of_scope -> document-creator]" }),
      user('[Plan step 1 — Data Access]: query.\n\nResult:\nTable'),
      assistant({ type: 'text', text: 'The Word document has been created.' }),
      user('[Plan step 2 — Text Document Creator]: write it.\n\nResult:\nok')
    ]
    expect(previousAnswerText(messages)).toBeUndefined()
  })
})
