import { describe, expect, it } from 'vitest'
import { checkUrlAllowed, recordKnownUrl } from './link-registry'

// Each test uses its own unique session id so the module-level registry
// (deliberately process-lifetime, not reset between tests) never leaks
// state across tests.
let counter = 0
function freshSessionId(): string {
  counter++
  return `test-session-${counter}`
}

describe('checkUrlAllowed', () => {
  it('allows anything for an origin with no known links yet — cold start can\'t be told apart from a user-given URL', () => {
    const session = freshSessionId()
    expect(checkUrlAllowed(session, 'https://example.com/some/guessed/path')).toEqual({ allowed: true })
  })

  it('allows an exact match to a previously recorded real link', () => {
    const session = freshSessionId()
    recordKnownUrl(session, 'https://example.com/real-article')
    expect(checkUrlAllowed(session, 'https://example.com/real-article')).toEqual({ allowed: true })
  })

  it('rejects a fabricated path once real links exist for that origin', () => {
    const session = freshSessionId()
    recordKnownUrl(session, 'https://example.com/real-article')
    const result = checkUrlAllowed(session, 'https://example.com/a-different-guessed-path')
    expect(result.allowed).toBe(false)
    expect((result as { reason: string }).reason).toMatch(/never guess or construct a path/)
  })

  it('always allows re-fetching the bare root, even once links are known', () => {
    const session = freshSessionId()
    recordKnownUrl(session, 'https://example.com/real-article')
    expect(checkUrlAllowed(session, 'https://example.com/')).toEqual({ allowed: true })
    expect(checkUrlAllowed(session, 'https://example.com')).toEqual({ allowed: true })
  })

  it('rejects the root plus a query/hash — not a genuinely bare root', () => {
    const session = freshSessionId()
    recordKnownUrl(session, 'https://example.com/real-article')
    const result = checkUrlAllowed(session, 'https://example.com/?utm_source=x')
    expect(result.allowed).toBe(false)
  })

  it('scopes known links per origin — a real link on one site does not license a guess on another', () => {
    const session = freshSessionId()
    recordKnownUrl(session, 'https://example.com/real-article')
    const result = checkUrlAllowed(session, 'https://other-site.com/guessed-path')
    expect(result.allowed).toBe(true) // other-site.com itself has no known links yet — cold start there
  })

  it('scopes known links per session — one conversation does not unlock another', () => {
    const sessionA = freshSessionId()
    const sessionB = freshSessionId()
    recordKnownUrl(sessionA, 'https://example.com/real-article')
    const result = checkUrlAllowed(sessionB, 'https://example.com/real-article')
    expect(result.allowed).toBe(true) // sessionB has no known links for this origin — cold start, not "unlocked"
  })

  it('lets a malformed URL through to fail naturally on the real fetch, rather than erroring here', () => {
    const session = freshSessionId()
    expect(checkUrlAllowed(session, 'not a url at all')).toEqual({ allowed: true })
  })
})

describe('recordKnownUrl', () => {
  it('silently ignores a malformed URL rather than throwing', () => {
    const session = freshSessionId()
    expect(() => recordKnownUrl(session, 'not a url')).not.toThrow()
  })
})
