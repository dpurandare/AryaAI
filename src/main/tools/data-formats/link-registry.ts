/**
 * A real, code-enforced (not just prompted) guard against a model
 * fabricating a plausible-looking URL — found live, twice, against real
 * news sites: once a real page from a given origin has actually been
 * fetched and its real links extracted (see html.ts's extractLinks), any
 * *further* fetch to that same origin must use one of those real links (or
 * re-fetch the bare root) — never a freshly invented path. A prompt-only
 * fix ("never guess a URL") was already tried once for the narrower
 * article-URL case and didn't reliably hold against this model family, so
 * this closes the gap structurally instead.
 *
 * Session-scoped (a fabricated-URL risk is about what THIS conversation
 * has actually seen, not a global cross-session allowlist) and purely
 * in-memory — reset on app restart, same lifetime as e.g. ipc/register.ts's
 * activeStreams map.
 *
 * Deliberately does NOT restrict the very *first* fetch to a brand-new
 * origin — there is no way to tell a model-invented URL apart from one the
 * user typed directly into their own message at that point, and blocking
 * every first contact would break the common, legitimate "here's a URL, go
 * check it" case. Once real links exist for an origin, though, there's no
 * legitimate reason left to guess instead of using one of them.
 */

const registry = new Map<string, Map<string, Set<string>>>()

/** Caps runaway growth within one very long session — real usage is nowhere near this. */
const MAX_URLS_PER_ORIGIN = 500

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

function isBareRoot(url: URL): boolean {
  return (url.pathname === '' || url.pathname === '/') && !url.search && !url.hash
}

/** Records a URL (a page actually fetched, or a real link extracted from one) as known-real for its origin. */
export function recordKnownUrl(sessionId: string, url: string): void {
  const origin = originOf(url)
  if (!origin) return
  let origins = registry.get(sessionId)
  if (!origins) {
    origins = new Map()
    registry.set(sessionId, origins)
  }
  let known = origins.get(origin)
  if (!known) {
    known = new Set()
    origins.set(origin, known)
  }
  if (known.size < MAX_URLS_PER_ORIGIN) known.add(url)
}

/**
 * Whether `url` is safe to fetch: allowed when its origin has no real
 * links on file yet for this session (nothing to compare against), when
 * it's the bare root of an origin we do know about (always a safe
 * re-anchor point to rediscover real links from), or when it's an exact
 * match for a real, previously-seen URL.
 */
export function checkUrlAllowed(sessionId: string, urlStr: string): { allowed: true } | { allowed: false; reason: string } {
  let url: URL
  try {
    url = new URL(urlStr)
  } catch {
    return { allowed: true } // let the real fetch fail naturally on a malformed URL
  }
  const known = registry.get(sessionId)?.get(url.origin)
  if (!known || known.size === 0) return { allowed: true }
  if (isBareRoot(url)) return { allowed: true }
  if (known.has(urlStr)) return { allowed: true }
  return {
    allowed: false,
    reason:
      `"${urlStr}" doesn't match any real link actually seen from ${url.origin} yet in this conversation. ` +
      'Use one of the real links from an earlier parse_html result for this site, or call parse_html on ' +
      `"${url.origin}/" again to rediscover them — never guess or construct a path yourself.`
  }
}
