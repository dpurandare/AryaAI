import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateRoleFile, ROLE_FILE_LIMITS } from '@shared/role-file'
import { EXAMPLE_ROLE_FILE, isRoleFileName, UserRoleLoader } from './user-roles'

const role = (id: string, extra = ''): string =>
  `---\nid: ${id}\nname: ${id.toUpperCase()}\nsummary: Does ${id} work. Does not do other work (Developer does).\nexamples: ["one ${id}", "two ${id}"]\nnotExamples: ["something else"]\ntools: [read_file]\n${extra}---\nYou are ${id}.\n`

describe('UserRoleLoader', () => {
  let dir: string
  let loader: UserRoleLoader
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sachiv-roles-'))
    loader = new UserRoleLoader(() => dir)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const put = (name: string, text: string): Promise<void> => writeFile(join(dir, name), text)
  const ids = (r: { roles: { file: { id: string } }[] }): string[] => r.roles.map((x) => x.file.id)

  it('a missing folder is simply no roles', async () => {
    const l = new UserRoleLoader(() => join(dir, 'nope'))
    expect(await l.load()).toEqual({ roles: [], problems: [] })
  })

  it('loads every valid .md file, sorted by file name, enabled by default (roles placed in the folder are the user\'s own config)', async () => {
    await put('b.md', role('beta'))
    await put('a.md', role('alpha'))
    const r = await loader.load()
    expect(ids(r)).toEqual(['alpha', 'beta'])
    expect(r.roles.every((x) => x.enabled && !x.stale)).toBe(true)
    expect(r.problems).toEqual([])
  })

  it('ignores files that are not role files: other extensions, leading _ or . (an example or draft can sit in the folder), subfolders', async () => {
    await put('notes.txt', 'x')
    await put('_draft.md', role('draft'))
    await put('.hidden.md', role('hidden'))
    await mkdir(join(dir, 'sub.md'))
    await put('real.md', role('real'))
    expect(ids(await loader.load())).toEqual(['real'])
    expect(isRoleFileName('_example-role.md')).toBe(false)
    expect(isRoleFileName('Role.MD')).toBe(true)
  })

  it('the shipped example file is itself valid — and does not load until it is renamed', async () => {
    const check = validateRoleFile(EXAMPLE_ROLE_FILE, {})
    expect(check.issues.filter((i) => i.level === 'error')).toEqual([])
    await put('_example-role.md', EXAMPLE_ROLE_FILE)
    expect(ids(await loader.load())).toEqual([])
    await put('example-role.md', EXAMPLE_ROLE_FILE)
    expect(ids(await loader.load())).toEqual(['example-reporter'])
  })

  it('reports an invalid file by name without stopping the others, and refuses built-in ids (extend-only)', async () => {
    await put('good.md', role('good'))
    await put('bad.md', role('coding')) // a built-in id
    await put('broken.md', 'no frontmatter at all')
    const r = await loader.load()
    expect(ids(r)).toEqual(['good'])
    expect(r.problems.filter((p) => p.file === 'bad.md').map((p) => p.message).join()).toMatch(/built-in/)
    expect(r.problems.find((p) => p.file === 'broken.md')?.message).toMatch(/frontmatter/)
  })

  it('the second of two files with the same id is rejected — the first (by file name) wins', async () => {
    await put('a.md', role('same'))
    await put('b.md', role('same'))
    const r = await loader.load()
    expect(r.roles.map((x) => x.sourceFile)).toEqual(['a.md'])
    expect(r.problems.find((p) => p.file === 'b.md')?.message).toMatch(/already exists/)
  })

  it('marks roles the user disabled in Settings (they stay listed, so they can be switched back on)', async () => {
    await put('a.md', role('alpha'))
    await put('b.md', role('beta'))
    const r = await loader.load({ disabledIds: new Set(['beta']) })
    expect(r.roles.map((x) => [x.file.id, x.enabled])).toEqual([['alpha', true], ['beta', false]])
  })

  it('applies an edit on the next load, with no restart', async () => {
    await put('a.md', role('alpha'))
    expect((await loader.load()).roles[0].file.prompt).toBe('You are alpha.')
    await put('a.md', role('alpha').replace('You are alpha.', 'You are ALPHA v2.'))
    const future = new Date(Date.now() + 5000)
    await utimes(join(dir, 'a.md'), future, future)
    expect((await loader.load()).roles[0].file.prompt).toBe('You are ALPHA v2.')
  })

  it('an edit that breaks the file keeps the last WORKING version, marks it stale, and says so — the role does not silently vanish mid-edit', async () => {
    await put('a.md', role('alpha'))
    await loader.load()
    await put('a.md', role('alpha').replace('tools: [read_file]', 'tools: read_file')) // now invalid
    const future = new Date(Date.now() + 5000)
    await utimes(join(dir, 'a.md'), future, future)
    const r = await loader.load()
    expect(r.roles).toHaveLength(1)
    expect(r.roles[0]).toMatchObject({ stale: true })
    expect(r.roles[0].file.tools).toEqual(['read_file'])
    expect(r.problems.some((p) => p.level === 'error' && /"tools" must be a list/.test(p.message))).toBe(true)
    expect(r.problems.some((p) => p.level === 'warning' && /last working version of "alpha"/.test(p.message))).toBe(true)
  })

  it('a deleted file removes its role, and the cached last-good copy with it', async () => {
    await put('a.md', role('alpha'))
    await loader.load()
    await rm(join(dir, 'a.md'))
    expect(ids(await loader.load())).toEqual([])
    await put('a.md', 'broken')
    expect(ids(await loader.load())).toEqual([]) // no ghost of the deleted role
  })

  it('refuses an oversized file and caps the number of roles (every summary reaches the router on every turn)', async () => {
    await put('huge.md', role('huge') + 'x'.repeat(ROLE_FILE_LIMITS.fileBytes))
    for (let i = 0; i < ROLE_FILE_LIMITS.roles + 3; i++) await put(`r${String(i).padStart(2, '0')}.md`, role(`role-${String.fromCharCode(97 + (i % 26))}${i < 26 ? '' : 'x'}${i}`))
    const r = await loader.load()
    expect(r.problems.find((p) => p.file === 'huge.md')?.message).toMatch(/bytes; the limit is/)
    expect(r.roles.length).toBeLessThanOrEqual(ROLE_FILE_LIMITS.roles)
    expect(r.problems.filter((p) => /only the first \d+ role files/.test(p.message)).length).toBeGreaterThan(0)
  })

  it('quality warnings load the role and travel with it', async () => {
    await put('a.md', role('alpha').replace(/summary: .*\n/, 'summary: Handles anything.\n'))
    const r = await loader.load()
    expect(ids(r)).toEqual(['alpha'])
    expect(r.roles[0].warnings.join(' | ')).toMatch(/over-broad/)
  })
})
