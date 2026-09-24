/**
 * TASKS.md #84 — a first-pass, mechanical detector for "variable-looking"
 * content inside an existing document's real text runs: dates, money
 * amounts, percentages, emails, phone numbers, URLs. Deliberately does NOT
 * attempt to recognize names/addresses/free-text labels — that needs real
 * judgment (is "Acme Corp" a company name to templatize, or a fixed brand
 * name that belongs in every output?), which the agent itself is better
 * positioned to reason about after reading the document's actual content
 * (office_read_document) than a regex heuristic guessing at English nouns
 * ever could be. This only handles the cheap, near-certain cases; the tool
 * built on top of it (office_extract_template) explicitly tells the agent
 * to propose additional candidates from its own reading for the user to
 * confirm — matching this project's existing "mechanical tool for cheap/
 * certain patterns, model reasoning for judgment calls" split (see #76's
 * note on dialect reasoning).
 */
export type PlaceholderCategory = 'date' | 'currency' | 'percentage' | 'email' | 'phone' | 'url'

export interface PlaceholderCandidate {
  text: string
  category: PlaceholderCategory
  suggestedName: string
  occurrences: number
}

const PATTERNS: { category: PlaceholderCategory; regex: RegExp }[] = [
  // ISO (2026-09-24), then month-name forms ("September 24, 2026" / "24 September 2026") — before the
  // slash/dash numeric form, which would otherwise also match the day/year digits inside those.
  { category: 'date', regex: /\b\d{4}-\d{2}-\d{2}\b/g },
  {
    category: 'date',
    regex:
      /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/gi
  },
  {
    category: 'date',
    regex:
      /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/gi
  },
  { category: 'date', regex: /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g },
  { category: 'currency', regex: /[$£€₹]\s?\d[\d,]*(?:\.\d{2})?\b/g },
  { category: 'percentage', regex: /\b\d+(?:\.\d+)?%/g },
  { category: 'email', regex: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { category: 'phone', regex: /(?:\+?\d{1,3}[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g },
  { category: 'url', regex: /https?:\/\/[^\s)]+/g }
]

/**
 * Scanned in `PATTERNS` order, first match wins per position — a value a
 * later pattern could also match (unlikely given how distinct these are,
 * e.g. currency vs. phone) is only ever counted once, under its first
 * matching category, so a candidate list never double-lists the same
 * literal text.
 */
export function detectPlaceholderCandidates(runs: string[]): PlaceholderCandidate[] {
  const seen = new Map<string, PlaceholderCandidate>()
  const perCategoryCounter: Partial<Record<PlaceholderCategory, number>> = {}

  for (const run of runs) {
    for (const { category, regex } of PATTERNS) {
      regex.lastIndex = 0
      for (const match of run.matchAll(regex)) {
        const text = match[0]
        const existing = seen.get(text)
        if (existing) {
          existing.occurrences++
          continue
        }
        const nextIndex = (perCategoryCounter[category] ?? 0) + 1
        perCategoryCounter[category] = nextIndex
        seen.set(text, { text, category, suggestedName: `${category}${nextIndex}`, occurrences: 1 })
      }
    }
  }

  return [...seen.values()]
}
