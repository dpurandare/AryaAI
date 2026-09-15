import type { ApiResponseResult } from './client'

const NEXT_URL_FIELDS = ['next', 'next_url', 'nextUrl', 'next_page', 'nextPage', 'nextPageUrl']

/** RFC 5988 Link header, e.g. `<https://api.example.com/x?page=2>; rel="next", <...>; rel="last"`. */
function nextFromLinkHeader(headers: Headers): string | undefined {
  const link = headers.get('link')
  if (!link) return undefined
  const nextPart = link
    .split(',')
    .map((part) => part.trim())
    .find((part) => /rel="?next"?/.test(part))
  return nextPart?.match(/<([^>]+)>/)?.[1]
}

/** A handful of common "next page URL" JSON field names — not exhaustive, but covers most REST APIs that don't use a Link header. */
function nextFromBody(bodyJson: unknown): string | undefined {
  if (!bodyJson || typeof bodyJson !== 'object') return undefined
  const obj = bodyJson as Record<string, unknown>
  for (const field of NEXT_URL_FIELDS) {
    const value = obj[field]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

/** Best-effort: a Link header wins (unambiguous, standard) over a body field. Returns undefined once neither is found — the caller stops paging there, which is also how a non-paginated API naturally terminates on its first (only) page. */
export function nextPageUrl(response: ApiResponseResult): string | undefined {
  return nextFromLinkHeader(response.headers) ?? nextFromBody(response.bodyJson)
}

/** Best-effort extraction of a page's list of items — a body that's itself an array, or one holding an array under a common wrapper key. Returns undefined when neither shape matches, so the caller can tell "nothing to concatenate" apart from "an empty page". */
export function extractItems(bodyJson: unknown): unknown[] | undefined {
  if (Array.isArray(bodyJson)) return bodyJson
  if (bodyJson && typeof bodyJson === 'object') {
    for (const key of ['items', 'data', 'results', 'records']) {
      const value = (bodyJson as Record<string, unknown>)[key]
      if (Array.isArray(value)) return value
    }
  }
  return undefined
}
