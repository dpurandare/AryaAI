import { isValidRoleId, type RoleMeta } from './agents'

/**
 * Validation for role records (design-discussion.md 3.2): a role's `summary` is
 * a routing contract, not a friendly description, so it is checked by code
 * rather than only by review. The same checks are meant to run on user-defined
 * roles at load time (design section 11).
 *
 * Two tiers, because the built-in summaries predate the contract:
 *  - `lintRoleStructure` — cheap, always-true invariants. Enforced on the real
 *    manifest today.
 *  - `lintRoutingSummary` — the semantic contract (states a non-scope AND a
 *    hand-off, no over-broad wording, doesn't overlap a sibling). Enforced on
 *    the real manifest once step 2 rewrites the summaries; until then it is
 *    unit-tested on synthetic records only.
 * Neither can prove routing quality — that is the (non-deterministic) routing
 * evaluation's job; a lint only stops the obvious regressions.
 */
export interface RoleLintIssue {
  role: string
  rule: string
  message: string
}

/** Roughly 30 tokens of English. */
export const MAX_SUMMARY_WORDS = 30

const BROAD_WORDS = /\b(anything|everything|all tasks?|any task|general[- ]purpose|general tasks?|whatever)\b/i
const NON_SCOPE_CUE = /\b(not|never|doesn'?t|does not|cannot|can'?t|no\b|without|only)\b/i

/** Word-set overlap above which two summaries are considered to compete for the same requests. */
const OVERLAP_THRESHOLD = 0.6

const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'of', 'for', 'in', 'on', 'with', 'is', 'are', 'it', 'its', 'that', 'this', 'given'])

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / (a.size + b.size - shared)
}

export function lintRoleStructure(roles: readonly RoleMeta[]): RoleLintIssue[] {
  const issues: RoleLintIssue[] = []
  const seen = new Set<string>()
  for (const r of roles) {
    const add = (rule: string, message: string): void => void issues.push({ role: r.id, rule, message })
    if (!isValidRoleId(r.id)) add('id-format', `id "${r.id}" must be lower-case letters, digits and single hyphens`)
    if (seen.has(r.id)) add('id-unique', `duplicate id "${r.id}"`)
    seen.add(r.id)
    if (!r.label.trim()) add('label', 'label is empty')
    if (!r.summary.trim()) add('summary', 'summary is empty')
    if (!r.description.trim()) add('description', 'description is empty')
    if (r.examples.length < 2) add('examples', `needs at least 2 examples (has ${r.examples.length})`)
    if (r.notExamples.length < 1) add('not-examples', 'needs at least 1 non-example')
  }
  return issues
}

/** `siblings` = every other role; used for the hand-off cue and the overlap check. */
export function lintRoutingSummary(role: RoleMeta, siblings: readonly RoleMeta[]): RoleLintIssue[] {
  const issues: RoleLintIssue[] = []
  const add = (rule: string, message: string): void => void issues.push({ role: role.id, rule, message })
  const s = role.summary

  const wordCount = s.trim().split(/\s+/).filter(Boolean).length
  if (wordCount > MAX_SUMMARY_WORDS) add('summary-length', `summary is ${wordCount} words; cap is ${MAX_SUMMARY_WORDS}`)
  if (BROAD_WORDS.test(s)) add('summary-broad', 'summary uses over-broad wording ("anything", "all tasks", "general", ...)')
  if (!NON_SCOPE_CUE.test(s)) add('summary-non-scope', 'summary must say what the role does NOT do')

  const mentionsSibling = siblings.some(
    (o) => o.id !== role.id && (s.toLowerCase().includes(o.label.toLowerCase()) || s.toLowerCase().includes(o.id))
  )
  // The pointer IS the hand-off: naming the role that takes the excluded work ("Does not X (Role)").
  if (!mentionsSibling) add('summary-handoff', 'summary must name the role that handles the excluded work')

  const mine = words(s)
  for (const o of siblings) {
    if (o.id === role.id) continue
    if (jaccard(mine, words(o.summary)) > OVERLAP_THRESHOLD) {
      add('summary-overlap', `summary overlaps heavily with "${o.id}"`)
    }
  }
  return issues
}
