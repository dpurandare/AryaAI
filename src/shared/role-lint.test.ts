import { describe, expect, it } from 'vitest'
import { ROLE_MANIFEST, roleMeta, AGENT_ROLES, AGENT_ROLE_LABELS, PLANNABLE_ROLES, type RoleMeta } from './agents'
import { lintRoleStructure, lintRoutingSummary, MAX_SUMMARY_WORDS } from './role-lint'

const base: RoleMeta = {
  id: 'reporter',
  label: 'Reporter',
  summary: 'Writes status reports from data. Does not run code — hands that to Terminal.',
  description: 'Writes reports.',
  pickable: true,
  plannable: true,
  examples: ['Write this week status report', 'Summarise the incidents'],
  notExamples: ['Run the report script [terminal]']
}
const terminal: RoleMeta = { ...base, id: 'terminal', label: 'Terminal', summary: 'Runs shell commands.' }

describe('the real role manifest', () => {
  it('passes the structural lint', () => {
    expect(lintRoleStructure(ROLE_MANIFEST)).toEqual([])
  })

  it('keeps every persisted role id, in the original order', () => {
    expect(ROLE_MANIFEST.map((r) => r.id)).toEqual([
      'planning', 'research', 'coding', 'terminal-devops', 'data', 'distribution', 'page-creator', 'email'
    ])
  })

  it('derives the picker, plan-target and label lists from it (page-creator is delegate-only)', () => {
    const expected = ['planning', 'research', 'coding', 'terminal-devops', 'data', 'distribution', 'email']
    expect(AGENT_ROLES).toEqual(expected)
    expect(PLANNABLE_ROLES).toEqual(expected)
    expect(AGENT_ROLE_LABELS['terminal-devops']).toBe('Terminal/DevOps')
    expect(AGENT_ROLE_LABELS['page-creator']).toBe('Page Creator')
    expect(Object.keys(AGENT_ROLE_LABELS).sort()).toEqual(ROLE_MANIFEST.map((r) => r.id).sort())
  })

  it('looks a role up by id', () => {
    expect(roleMeta('data')?.label).toBe('Data')
    expect(roleMeta('nope')).toBeUndefined()
  })
})

describe('lintRoleStructure', () => {
  it('accepts a well-formed record', () => {
    expect(lintRoleStructure([base])).toEqual([])
  })

  it.each([
    ['id-format', { id: 'Bad_Id' }],
    ['label', { label: ' ' }],
    ['summary', { summary: '' }],
    ['description', { description: '' }],
    ['examples', { examples: ['only one'] }],
    ['not-examples', { notExamples: [] }]
  ] as const)('flags %s', (rule, patch) => {
    expect(lintRoleStructure([{ ...base, ...patch }]).map((i) => i.rule)).toContain(rule)
  })

  it('flags duplicate ids', () => {
    expect(lintRoleStructure([base, base]).map((i) => i.rule)).toContain('id-unique')
  })
})

describe('lintRoutingSummary', () => {
  it('accepts a contract that states a non-scope and a hand-off', () => {
    expect(lintRoutingSummary(base, [base, terminal])).toEqual([])
  })

  it('rejects a summary that is too long', () => {
    const long = { ...base, summary: Array(MAX_SUMMARY_WORDS + 5).fill('word').join(' ') + ' not use Terminal' }
    expect(lintRoutingSummary(long, [long, terminal]).map((i) => i.rule)).toContain('summary-length')
  })

  it('rejects over-broad wording', () => {
    const broad = { ...base, summary: 'Handles anything you need. Not shell — use Terminal.' }
    expect(lintRoutingSummary(broad, [broad, terminal]).map((i) => i.rule)).toContain('summary-broad')
  })

  it('requires a non-scope statement', () => {
    const none = { ...base, summary: 'Writes status reports from data, then Terminal runs things.' }
    expect(lintRoutingSummary(none, [none, terminal]).map((i) => i.rule)).toContain('summary-non-scope')
  })

  it('requires a hand-off that names another role', () => {
    const vague = { ...base, summary: 'Writes reports. Does not run code.' }
    expect(lintRoutingSummary(vague, [vague, terminal]).map((i) => i.rule)).toContain('summary-handoff')
  })

  it('flags two summaries that compete for the same requests', () => {
    const twin = { ...terminal, id: 'shell', label: 'Shell', summary: 'Runs shell commands quickly.' }
    expect(lintRoutingSummary(terminal, [terminal, twin]).map((i) => i.rule)).toContain('summary-overlap')
  })
})
