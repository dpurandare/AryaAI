import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from './workspace-guard'
import { ExternalAccess, resolveReadable, resolveWritableNewOutside } from './external-access'

describe('external access', () => {
  let root: string
  let outside: string
  let always: string[]
  let access: ExternalAccess
  const home = join(tmpdir(), 'fake-home')
  const ctxOf = (a: ExternalAccess | undefined, sessionId = 's1') => ({ workspaceGuard: new WorkspaceGuard(root), currentSessionId: sessionId, externalAccess: a })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-ea-root-'))
    outside = await mkdtemp(join(tmpdir(), 'sachiv-ea-out-'))
    await writeFile(join(outside, 'a.txt'), 'x')
    always = []
    access = new ExternalAccess({ getAlways: () => always, setAlways: (l) => (always = l), home })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('paths inside the workspace never need a grant', () => {
    expect(resolveReadable(ctxOf(undefined), 'docs/x.txt')).toBe(join(root, 'docs', 'x.txt'))
  })

  it('a leading ~ is the home folder: protected places stay refused, other places ask first (TASKS #235)', () => {
    const real = new ExternalAccess({ getAlways: () => always, setAlways: (l) => (always = l), home: homedir() })
    expect(() => resolveReadable(ctxOf(real), '~/.ssh/id_rsa')).toThrow(/protected location/)
    expect(() => resolveReadable(ctxOf(real), '~/Downloads/x.txt')).toThrow(/outside the workspace and Sachivji has not been given access/)
    expect(() => resolveWritableNewOutside(ctxOf(real), '~/.aws/credentials')).toThrow(/protected location/)
  })

  it('an outside path is refused until its folder is granted, and a grant covers the folder and everything below it', async () => {
    const file = join(outside, 'a.txt')
    expect(() => resolveReadable(ctxOf(access), file)).toThrow(/outside the workspace and Sachivji has not been given access/)
    access.grant('s1', outside, 'session')
    expect(resolveReadable(ctxOf(access), file)).toBe(file)
    await mkdir(join(outside, 'deep', 'er'), { recursive: true })
    expect(resolveReadable(ctxOf(access), join(outside, 'deep', 'er', 'b.txt'))).toBe(join(outside, 'deep', 'er', 'b.txt'))
    expect(() => resolveReadable(ctxOf(access), join(outside, '..', 'elsewhere.txt'))).toThrow(/not been given access/)
  })

  it('a session grant belongs to that session only; an "always" grant persists and can be revoked', () => {
    const file = join(outside, 'a.txt')
    access.grant('s1', outside, 'session')
    expect(access.isReadAllowed('s2', file)).toBe(false)
    access.grant('s2', outside, 'always')
    expect(always).toEqual([outside])
    expect(access.isReadAllowed('anything', file)).toBe(true)
    access.revokeAlways(outside)
    expect(access.isReadAllowed('anything', file)).toBe(false)
  })

  it('a once-grant lasts only until released', () => {
    const release = access.grantOnce(outside)
    expect(access.isReadAllowed('s1', join(outside, 'a.txt'))).toBe(true)
    release()
    expect(access.isReadAllowed('s1', join(outside, 'a.txt'))).toBe(false)
  })

  it('credentials, keys, the keychain, system config and Sachivji\'s own data are never reachable, even if a parent folder is granted', () => {
    access.grant('s1', home, 'always')
    for (const p of [join(home, '.ssh', 'id_rsa'), join(home, '.aws', 'credentials'), join(home, 'Library', 'Keychains', 'login.keychain-db'), join(home, 'Library', 'Application Support', 'Sachivji', 'credentials.enc.json'), join(home, '.sachivji', '.env'), '/etc/hosts']) {
      expect(access.isBlocked(p), p).toBe(true)
      expect(access.isReadAllowed('s1', p), p).toBe(false)
      expect(() => resolveReadable(ctxOf(access), p)).toThrow(/protected location/)
    }
    expect(access.isBlocked(join(home, 'Downloads', 'x.pdf'))).toBe(false)
  })

  it('folderFor: a directory is itself, a file is its parent folder', () => {
    expect(access.folderFor(outside)).toBe(outside)
    expect(access.folderFor(join(outside, 'a.txt'))).toBe(outside)
    expect(access.folderFor(join(outside, 'not-there.txt'))).toBe(outside)
  })

  it('creating a new file outside: only with a call-scoped grant, only if it does not exist, only in an existing folder', async () => {
    const fresh = join(outside, 'new.txt')
    expect(() => resolveWritableNewOutside(ctxOf(access), fresh)).toThrow(/needs the user's confirmation/)
    const release = access.grantOnce(outside)
    expect(resolveWritableNewOutside(ctxOf(access), fresh)).toBe(fresh)
    expect(() => resolveWritableNewOutside(ctxOf(access), join(outside, 'a.txt'))).toThrow(/never overwrites or edits/)
    expect(() => resolveWritableNewOutside(ctxOf(access), join(outside, 'nofolder', 'x.txt'))).toThrow(/does not create folders/)
    release()
    // a read grant ('session'/'always') never allows writing
    access.grant('s1', outside, 'always')
    expect(() => resolveWritableNewOutside(ctxOf(access), fresh)).toThrow(/needs the user's confirmation/)
  })
})
