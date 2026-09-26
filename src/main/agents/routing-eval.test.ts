import { describe, expect, it } from 'vitest'
import { ROLE_MANIFEST } from '@shared/agents'
import { MockProvider } from '../../../test/support/mock-provider'
import { collapseUnavailableToolCalls } from '../context/prepare-context'
import {
  buildRoutingCases,
  formatRoutingReport,
  isCorrect,
  replayProbeHistory,
  roleFromDelegateName,
  runReplayProbe,
  runRoutingEval,
  type EvalSetup
} from './routing-eval'

const setup: EvalSetup = {
  system: 'You are Sachivji.',
  tools: [],
  toolOwner: (n) => ({ shell_execute: 'coding', read_file: 'coding' })[n]
}

describe('buildRoutingCases', () => {
  const cases = buildRoutingCases()

  it('turns every routable role\'s examples into cases expecting that role', () => {
    for (const r of ROLE_MANIFEST.filter((x) => x.pickable || x.plannable)) {
      for (const ex of r.examples) expect(cases).toContainEqual({ prompt: ex, expectedRole: r.id, kind: 'example', from: r.id })
    }
  })

  it('turns non-examples into cases expecting the role named in the bracket, with the bracket removed from the prompt', () => {
    expect(cases).toContainEqual({ prompt: 'Save these findings into a Word document', expectedRole: 'document-creator', kind: 'notExample', from: 'research' })
    expect(cases.every((c) => !c.prompt.includes('['))).toBe(true)
  })

  it('takes the FIRST role of a multi-role bracket and skips "orchestrator" (not a delegation target) and the internal Page Creator', () => {
    expect(cases).toContainEqual({ prompt: 'Find out who our largest customer is, then email them', expectedRole: 'data', kind: 'notExample', from: 'email' })
    expect(cases.some((c) => c.from === 'page-creator')).toBe(false)
    expect(cases.some((c) => c.expectedRole === 'orchestrator')).toBe(false)
  })

  it('every expected role is a real role id', () => {
    const ids = new Set<string>(ROLE_MANIFEST.map((r) => r.id))
    for (const c of cases) expect(ids.has(c.expectedRole), c.expectedRole).toBe(true)
  })
})

describe('roleFromDelegateName / isCorrect', () => {
  it('maps delegate tool names back to role ids, including hyphenated ones', () => {
    expect(roleFromDelegateName('delegate_to_coding')).toBe('coding')
    expect(roleFromDelegateName('delegate_to_history_analyst')).toBe('history-analyst')
    expect(roleFromDelegateName('delegate_to_wizard')).toBeUndefined()
    expect(roleFromDelegateName('shell_execute')).toBeUndefined()
  })

  it('delegating to the expected role is correct; to another is not', () => {
    expect(isCorrect({ type: 'delegate', role: 'data' }, 'data', setup.toolOwner)).toBe(true)
    expect(isCorrect({ type: 'delegate', role: 'coding' }, 'data', setup.toolOwner)).toBe(false)
  })

  it('handling it directly with a core tool the expected role owns counts as correct (a router that runs shell_execute did fine)', () => {
    expect(isCorrect({ type: 'tool', name: 'shell_execute' }, 'coding', setup.toolOwner)).toBe(true)
    expect(isCorrect({ type: 'tool', name: 'shell_execute' }, 'data', setup.toolOwner)).toBe(false)
  })

  it('a plain answer is correct only for the reasoning-only Planner; an error never is', () => {
    expect(isCorrect({ type: 'answer' }, 'planning', setup.toolOwner)).toBe(true)
    expect(isCorrect({ type: 'answer' }, 'data', setup.toolOwner)).toBe(false)
    expect(isCorrect({ type: 'error', message: 'x' }, 'planning', setup.toolOwner)).toBe(false)
  })
})

describe('runRoutingEval', () => {
  const cases = [
    { prompt: 'How many customers?', expectedRole: 'data', kind: 'example' as const, from: 'data' },
    { prompt: 'Run analysis.py', expectedRole: 'coding', kind: 'example' as const, from: 'coding' },
    { prompt: 'Chart it', expectedRole: 'coding', kind: 'notExample' as const, from: 'data' },
    { prompt: 'Plan my week', expectedRole: 'planning', kind: 'example' as const, from: 'planning' }
  ]

  it('records what the model did on the first round, without executing anything, and scores it', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: '1', name: 'delegate_to_data', input: { task: 'x' } }] }, // correct
      { toolCalls: [{ id: '2', name: 'shell_execute', input: { command: 'python analysis.py' } }] }, // correct (owned by coding)
      { toolCalls: [{ id: '3', name: 'delegate_to_data', input: { task: 'x' } }] }, // wrong role
      { text: 'Here is a plan...', stopReason: 'end_turn' } // planner answers directly: correct
    ])
    const report = await runRoutingEval(provider, 'm', setup, cases)
    expect(report.correct).toBe(3)
    expect(report.total).toBe(4)
    expect(report.byRole).toEqual({ data: [1, 1], coding: [1, 2], planning: [1, 1] })
    expect(provider.requests).toHaveLength(4) // one round per case — nothing continued after a tool call
    expect(provider.requests[0]).toMatchObject({ system: 'You are Sachivji.', messages: [{ role: 'user' }] })
  })

  it('a provider error becomes an error outcome (counted wrong), not a crash', async () => {
    const provider = new MockProvider([{ throwError: 'rate limited' }])
    const report = await runRoutingEval(provider, 'm', setup, [cases[0]])
    expect(report.outcomes[0].choice).toEqual({ type: 'error', message: 'rate limited' })
    expect(report.correct).toBe(0)
  })

  it('the report names every miss with what was expected and what happened', async () => {
    const provider = new MockProvider([{ toolCalls: [{ id: '1', name: 'delegate_to_coding', input: {} }] }])
    const text = formatRoutingReport(await runRoutingEval(provider, 'm', setup, [cases[0]]))
    expect(text).toContain('mock / m: 0/1 correct')
    expect(text).toContain('"How many customers?" → expected data, got delegate coding')
  })
})

describe('replay probe', () => {
  it('sends the raw history and the collapsed history, and reports whether each was accepted', async () => {
    const provider = new MockProvider([{ text: 'Hello!', stopReason: 'end_turn' }, { throwError: '400 Bad Request' }])
    const raw = replayProbeHistory()
    const results = await runReplayProbe(provider, 'm', raw, collapseUnavailableToolCalls(raw, new Set()), [])
    expect(results).toEqual([
      { variant: 'raw', accepted: true },
      { variant: 'collapsed', accepted: false, error: '400 Bad Request' }
    ])
  })

  it('the raw history really contains a call to a tool that is absent, and collapsing it leaves no tool_use / tool_result at all', () => {
    const raw = replayProbeHistory()
    expect(raw.flatMap((m) => m.content).some((b) => b.type === 'tool_use' && b.name === 'xlsx_write')).toBe(true)
    const collapsed = collapseUnavailableToolCalls(raw, new Set(['shell_execute']))
    expect(collapsed.flatMap((m) => m.content).some((b) => b.type === 'tool_use' || b.type === 'tool_result')).toBe(false)
  })
})
