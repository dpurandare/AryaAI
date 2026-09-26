import { describe, expect, it } from 'vitest'
import {
  AGENT_ROLES,
  explainInvalidRoleId,
  isValidRoleId,
  MAX_ROLE_ID_LENGTH,
  ROLE_MANIFEST,
  roleLabel,
  type AgentRole,
  type BuiltinRoleId
} from './agents'

describe('AgentRole is an open, validated string (design step: widening)', () => {
  it('accepts an id the compiler has never heard of — user-defined roles will bring them', () => {
    const userRole: AgentRole = 'sql-reporter'
    const builtin: BuiltinRoleId = 'coding'
    expect([userRole, builtin]).toEqual(['sql-reporter', 'coding'])
  })

  it('every built-in id (and picker id) is itself a valid id', () => {
    for (const r of ROLE_MANIFEST) expect(isValidRoleId(r.id), r.id).toBe(true)
    for (const id of AGENT_ROLES) expect(isValidRoleId(id), id).toBe(true)
  })
})

describe('isValidRoleId', () => {
  it.each(['coding', 'sql-reporter', 'a', 'role2', 'data-access-v2'])('accepts %s', (id) => {
    expect(isValidRoleId(id)).toBe(true)
  })

  it.each(['', 'Coding', 'sql_reporter', 'sql reporter', '-lead', 'trail-', 'double--hyphen', '9lives', 'émigré', 'a'.repeat(MAX_ROLE_ID_LENGTH + 1)])('rejects %j', (id) => {
    expect(isValidRoleId(id)).toBe(false)
  })

  it.each([null, undefined, 42, {}, [], true])('rejects a non-string (%j) — a pinned role arrives over IPC as anything', (v) => {
    expect(isValidRoleId(v)).toBe(false)
  })

  it('an id at exactly the length limit is fine', () => {
    expect(isValidRoleId('a'.repeat(MAX_ROLE_ID_LENGTH))).toBe(true)
  })
})

describe('explainInvalidRoleId (for a NEW role)', () => {
  it('returns undefined for a fine, unused id', () => {
    expect(explainInvalidRoleId('sql-reporter')).toBeUndefined()
    expect(explainInvalidRoleId('sql-reporter', ['other'])).toBeUndefined()
  })

  it('explains each way an id is wrong', () => {
    expect(explainInvalidRoleId('')).toMatch(/non-empty/)
    expect(explainInvalidRoleId(7)).toMatch(/non-empty string/)
    expect(explainInvalidRoleId('x'.repeat(MAX_ROLE_ID_LENGTH + 1))).toMatch(/at most/)
    expect(explainInvalidRoleId('Sql_Reporter')).toMatch(/lower-case letters, digits and single hyphens/)
  })

  it('reserves the sentinel ids and anything in the delegate namespace', () => {
    for (const id of ['router', 'auto', 'orchestrator', 'delegate', 'delegate-to-coding', 'delegates']) expect(explainInvalidRoleId(id), id).toMatch(/reserved/)
  })

  it('never lets a user role take a built-in id, or a retired one (extend-only)', () => {
    expect(explainInvalidRoleId('coding')).toMatch(/built-in/)
    expect(explainInvalidRoleId('mcp-operator')).toMatch(/built-in/)
    expect(explainInvalidRoleId('terminal-devops')).toMatch(/built-in/)
    expect(explainInvalidRoleId('distribution')).toMatch(/built-in/)
  })

  it('rejects an id already taken', () => {
    expect(explainInvalidRoleId('sql-reporter', ['sql-reporter'])).toMatch(/already exists/)
  })
})

describe('delegate tool names map back to exactly one id', () => {
  // orchestrator.ts: delegate_to_<id with hyphens → underscores>, and back by underscores → hyphens. That is only safe because ids have
  // no underscores; otherwise `a_b` and `a-b` would collide on `delegate_to_a_b`.
  const forward = (id: string): string => 'delegate_to_' + id.replace(/-/g, '_')
  const back = (name: string): string => name.slice('delegate_to_'.length).replace(/_/g, '-')

  it('round-trips every built-in id and a spread of valid ones', () => {
    for (const id of [...ROLE_MANIFEST.map((r) => r.id), 'sql-reporter', 'a', 'x1-y2-z3']) expect(back(forward(id)), id).toBe(id)
  })

  it('no two valid ids can share a delegate name (the only way to collide needs an underscore, which is invalid)', () => {
    expect(isValidRoleId('a_b')).toBe(false)
    expect(forward('a-b')).toBe('delegate_to_a_b')
    const ids = ROLE_MANIFEST.map((r) => forward(r.id))
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('roleLabel', () => {
  it('gives the real label for built-in and retired roles', () => {
    expect(roleLabel('coding')).toBe('Developer')
    expect(roleLabel('mcp-operator')).toBe('MCP Operator')
    expect(roleLabel('terminal-devops')).toBe('Terminal/DevOps')
  })

  it('humanizes an id that no longer resolves instead of returning undefined (a chip must never be blank)', () => {
    expect(roleLabel('sql-reporter')).toBe('Sql Reporter')
    expect(roleLabel('x')).toBe('X')
    expect(roleLabel('data_wizard v2')).toBe('Data Wizard V2')
  })

  it('never returns an empty string', () => {
    expect(roleLabel('')).toBe('Unknown')
    expect(roleLabel('---')).toBe('Unknown')
  })
})
