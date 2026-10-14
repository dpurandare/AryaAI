import { describe, expect, it } from 'vitest'
import { ROLE_MANIFEST } from './agents'
import { parseFrontmatter, ROLE_FILE_LIMITS, toolMatchesPattern, validateRoleFile } from './role-file'

const good = `---
id: sql-reporter                       # unique, hyphens only
name: SQL Reporter
summary: Runs read-only SQL and formats a summary. Does not modify data (Data Access does writes).
description: Fuller text for listings.
examples: ["Show last month's revenue by region", "How many orders were placed today?"]
notExamples: ["Update the customer table [data]"]
tools: [db_list_connections, db_execute_sql, "db_query_*"]
maxRounds: 6
isolated: false
pickable: true
plannable: true
---
You are the SQL Reporter. Read data only; never write.
`

const errors = (r: { issues: { level: string; message: string }[] }): string[] => r.issues.filter((i) => i.level === 'error').map((i) => i.message)
const warnings = (r: { issues: { level: string; message: string }[] }): string[] => r.issues.filter((i) => i.level === 'warning').map((i) => i.message)

describe('parseFrontmatter', () => {
  it('reads scalars, quoted strings, one-line lists, booleans, numbers and skips comments and blank lines', () => {
    const { data, body, issues } = parseFrontmatter('---\n# a comment\n\nname: Hello # trailing\nlist: [a, "b, c", \'d\']\nflag: true\nn: 7\nquoted: "has # a hash"\n---\nBody text.\n')
    expect(issues.filter((i) => i.level === 'error')).toEqual([])
    expect(data).toEqual({ name: 'Hello', list: ['a', 'b, c', 'd'], flag: true, n: 7, quoted: 'has # a hash' })
    expect(body).toBe('Body text.')
  })

  it('handles CRLF line endings and a BOM (files edited on Windows)', () => {
    const { data, body } = parseFrontmatter('﻿---\r\nname: X\r\n---\r\nPrompt\r\n')
    expect(data).toEqual({ name: 'X' })
    expect(body).toBe('Prompt')
  })

  it('reports a file with no frontmatter block', () => {
    expect(parseFrontmatter('just text').issues[0]).toMatchObject({ level: 'error', message: expect.stringContaining('frontmatter') })
    expect(parseFrontmatter('---\nname: X\nno closing').issues[0].level).toBe('error')
  })

  it('rejects multi-line values, duplicate keys and unterminated quotes/lists with a line number, and warns on an unknown field', () => {
    const { issues } = parseFrontmatter('---\nname: X\nname: Y\nsummary: "unterminated\nlist: [a, b\n  indented continuation\nmystery: 1\n---\nx')
    const msgs = issues.map((i) => i.message)
    expect(msgs.some((m) => /"name" is given more than once/.test(m))).toBe(true)
    expect(msgs.some((m) => /"summary".*closing quote/.test(m))).toBe(true)
    expect(msgs.some((m) => /"list".*one line/.test(m))).toBe(true)
    expect(msgs.some((m) => /line \d+ is not "key: value"/.test(m))).toBe(true)
    expect(issues.find((i) => /mystery/.test(i.message))?.level).toBe('warning')
  })
})

describe('validateRoleFile — a good file', () => {
  const r = validateRoleFile(good, { siblings: ROLE_MANIFEST })
  it('loads with every field', () => {
    expect(errors(r)).toEqual([])
    expect(r.role).toMatchObject({
      id: 'sql-reporter', name: 'SQL Reporter', maxRounds: 6, isolated: false, pickable: true, plannable: true,
      tools: ['db_list_connections', 'db_execute_sql', 'db_query_*'], prompt: 'You are the SQL Reporter. Read data only; never write.'
    })
    expect(r.role?.examples).toHaveLength(2)
  })
  it('a good summary that names its hand-off role produces no routing warnings', () => {
    expect(warnings(r)).toEqual([])
  })
  it('defaults: pickable / plannable true, isolated false, description falls back to the summary', () => {
    const min = validateRoleFile('---\nid: helper\nname: Helper\nsummary: Helps with X. Does not do Y (Developer does).\n---\nBe helpful.', { siblings: ROLE_MANIFEST })
    expect(min.role).toMatchObject({ pickable: true, plannable: true, isolated: false, tools: [] })
    expect(min.role?.description).toBe(min.role?.summary)
  })
})

describe('validateRoleFile — errors (the role is NOT loaded)', () => {
  const withField = (patch: string): string => good.replace('maxRounds: 6', patch)

  it.each([
    ['a built-in id (extend-only)', good.replace('id: sql-reporter', 'id: coding'), /built-in/],
    ['a retired id', good.replace('id: sql-reporter', 'id: distribution'), /built-in/],
    ['a reserved id', good.replace('id: sql-reporter', 'id: router'), /reserved/],
    ['the delegate namespace', good.replace('id: sql-reporter', 'id: delegate-tool'), /reserved/],
    ['uppercase / underscores', good.replace('id: sql-reporter', 'id: Sql_Reporter'), /lower-case/],
    ['no id', good.replace('id: sql-reporter                       # unique, hyphens only\n', ''), /id:/],
    ['no name', good.replace('name: SQL Reporter\n', ''), /"name" is required/],
    ['no summary', good.replace(/summary: .*\n/, ''), /"summary" is required/],
    ['an over-long summary', good.replace(/summary: .*\n/, `summary: ${'x'.repeat(ROLE_FILE_LIMITS.summaryChars + 1)}\n`), /"summary" is .* characters; the limit/],
    ['a non-list tools field', good.replace(/tools: .*\n/, 'tools: db_execute_sql\n'), /"tools" must be a list/],
    ['a malformed tool pattern', good.replace('db_list_connections,', 'db list,'), /not a tool name/],
    ['a wildcard in the middle', good.replace('"db_query_*"', '"db_*_x"'), /not a tool name/],
    ['too many tool patterns', good.replace(/tools: .*\n/, `tools: [${Array.from({ length: 41 }, (_, i) => `t${i}`).join(', ')}]\n`), /41 entries; the limit is 40/],
    ['a non-boolean flag', good.replace('pickable: true', 'pickable: yes please'), /"pickable" must be true or false/],
    ['maxRounds out of range', withField('maxRounds: 99'), /"maxRounds" must be a whole number from 1 to 30/],
    ['maxRounds not a number', withField('maxRounds: many'), /"maxRounds"/],
    ['an empty prompt', good.replace(/---\nYou are.*\n$/, '---\n'), /no prompt after the frontmatter/],
    ['a huge prompt', good + 'x'.repeat(ROLE_FILE_LIMITS.promptChars), /prompt is .* characters; the limit/]
  ])('rejects %s', (_label, text, expected) => {
    const r = validateRoleFile(text, { siblings: ROLE_MANIFEST })
    expect(r.role).toBeUndefined()
    expect(errors(r).join(' | ')).toMatch(expected)
  })

  it('a file with no frontmatter gets exactly ONE error, not a cascade of "missing id / name / summary / prompt"', () => {
    const r = validateRoleFile('just some notes', {})
    expect(r.role).toBeUndefined()
    expect(errors(r)).toHaveLength(1)
    expect(errors(r)[0]).toMatch(/must start with a "---" frontmatter block/)
  })

  it('rejects an id another role already has', () => {
    const r = validateRoleFile(good, { takenIds: ['sql-reporter'] })
    expect(r.role).toBeUndefined()
    expect(errors(r).join()).toMatch(/already exists/)
  })
})

describe('validateRoleFile — warnings (the role LOADS, Settings shows them)', () => {
  it('flags a routing-hijack summary ("handles all requests") without refusing the role (design 11.5)', () => {
    const r = validateRoleFile(good.replace(/summary: .*\n/, 'summary: Handles anything you throw at it.\n'), { siblings: ROLE_MANIFEST })
    expect(r.role).toBeDefined()
    expect(warnings(r).join(' | ')).toMatch(/over-broad wording/)
    expect(warnings(r).join(' | ')).toMatch(/does NOT do|name the role/)
  })

  it('flags too few examples, and a role with no tools', () => {
    const r = validateRoleFile('---\nid: chatty\nname: Chatty\nsummary: Chats. Does not use tools (Developer does).\n---\nChat.', { siblings: ROLE_MANIFEST })
    expect(r.role).toBeDefined()
    expect(warnings(r).join(' | ')).toMatch(/at least 2 examples/)
    expect(warnings(r).join(' | ')).toMatch(/No tools: this role can only reason/)
  })

  it('flags a summary that overlaps a built-in role heavily', () => {
    const dev = ROLE_MANIFEST.find((x) => x.id === 'coding')!
    const r = validateRoleFile(good.replace(/summary: .*\n/, `summary: ${dev.summary}\n`), { siblings: ROLE_MANIFEST })
    expect(warnings(r).join(' | ')).toMatch(/overlaps heavily with "coding"/)
  })
})

describe('toolMatchesPattern', () => {
  it('matches an exact name, or a prefix ending in *', () => {
    expect(toolMatchesPattern('db_execute_sql', 'db_execute_sql')).toBe(true)
    expect(toolMatchesPattern('db_execute_sql', 'db_execute_sql2')).toBe(false)
    expect(toolMatchesPattern('db_query_*', 'db_query_top10_abc')).toBe(true)
    expect(toolMatchesPattern('db_query_*', 'db_list_rows')).toBe(false)
    expect(toolMatchesPattern('mcp__wiki__*', 'mcp__wiki__search')).toBe(true)
  })
})
