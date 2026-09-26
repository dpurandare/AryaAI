import { describe, expect, it } from 'vitest'
import { ROLE_MANIFEST } from '@shared/agents'
import { validateRoleFile } from '@shared/role-file'
import { buildRoster, roleTokenCost, USER_ROLE_COUNT_WARNING, USER_ROLE_TOKEN_WARNING } from './roster'
import type { LoadedRole, LoadResult } from './user-roles'

function loaded(id: string, over: Partial<LoadedRole> = {}, summary = `Does ${id} work. Does not do other work (Developer does).`): LoadedRole {
  const file = validateRoleFile(`---\nid: ${id}\nname: ${id.toUpperCase()}\nsummary: ${summary}\nexamples: ["a ${id}", "b ${id}"]\nnotExamples: ["c"]\ntools: [read_file]\n---\nPrompt.`, { siblings: ROLE_MANIFEST }).role!
  return { file, sourceFile: `${id}.md`, warnings: [], enabled: true, stale: false, ...over }
}
const result = (roles: LoadedRole[], problems: LoadResult['problems'] = []): LoadResult => ({ roles, problems })

describe('roleTokenCost', () => {
  it('is the delegate tool plus a planner-list line, and grows with the summary', () => {
    const short = roleTokenCost('helper', 'Helper', 'Helps.', true)
    const long = roleTokenCost('helper', 'Helper', 'Helps with a great many things across many domains, in considerable detail. '.repeat(4), true)
    expect(short).toBeGreaterThan(40)
    expect(long).toBeGreaterThan(short)
  })
  it('a role that is not plannable costs less: it has no line in the planner\'s role list', () => {
    expect(roleTokenCost('helper', 'Helper', 'Helps.', false)).toBeLessThan(roleTokenCost('helper', 'Helper', 'Helps.', true))
  })
})

describe('buildRoster', () => {
  it('lists every built-in first, read-only and always enabled, then the user\'s roles', () => {
    const r = buildRoster(result([loaded('alpha')]), '/data/roles')
    expect(r.roles.slice(0, ROLE_MANIFEST.length).map((x) => x.id)).toEqual(ROLE_MANIFEST.map((x) => x.id))
    expect(r.roles.slice(0, ROLE_MANIFEST.length).every((x) => x.builtin && x.enabled)).toBe(true)
    expect(r.roles.at(-1)).toMatchObject({ id: 'alpha', label: 'ALPHA', builtin: false, enabled: true, file: 'alpha.md', pickable: true, plannable: true })
    expect(r.folder).toBe('/data/roles')
  })

  it('carries warnings, the stale flag and load problems through to the renderer', () => {
    const r = buildRoster(result([loaded('alpha', { warnings: ['Routing summary: is over-broad.'], stale: true })], [{ file: 'bad.md', level: 'error', message: 'nope' }]), '/f')
    expect(r.roles.at(-1)).toMatchObject({ warnings: ['Routing summary: is over-broad.'], stale: true })
    expect(r.problems).toEqual([{ file: 'bad.md', level: 'error', message: 'nope' }])
  })

  it('counts only ENABLED user roles toward the cost', () => {
    const a = loaded('alpha')
    const b = loaded('beta', { enabled: false })
    const r = buildRoster(result([a, b]), '/f')
    const cost = (id: string): number => r.roles.find((x) => x.id === id)!.tokenCost
    expect(r.userTokenCost).toBe(cost('alpha'))
    expect(r.roles.find((x) => x.id === 'beta')?.enabled).toBe(false)
  })

  it('no warning for a few small roles', () => {
    expect(buildRoster(result([loaded('alpha'), loaded('beta')]), '/f').budgetWarning).toBeUndefined()
  })

  it('warns when there are many enabled user roles', () => {
    const many = Array.from({ length: USER_ROLE_COUNT_WARNING + 1 }, (_, i) => loaded(`role-${'abcdefghij'[i]}`))
    const w = buildRoster(result(many), '/f').budgetWarning
    expect(w).toMatch(new RegExp(`${many.length} of your roles are enabled`))
  })

  it('warns when the enabled roles together are heavy, even if there are few', () => {
    const heavySummary = 'Does a very large number of detailed things for the user across many different domains and situations. '.repeat(3) + 'Does not do other work (Developer does).'
    const heavy = Array.from({ length: 4 }, (_, i) => loaded(`heavy-${'abcd'[i]}`, {}, heavySummary))
    const r = buildRoster(result(heavy), '/f')
    expect(r.userTokenCost).toBeGreaterThan(USER_ROLE_TOKEN_WARNING)
    expect(r.budgetWarning).toMatch(/add about \d+ tokens to every request/)
  })
})
