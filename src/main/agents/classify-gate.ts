/**
 * Phase 1 of TASKS.md #95 — a cheap, deterministic pre-check ahead of
 * `classifyAndPlan`'s own real LLM call, so an obviously simple request
 * (a greeting, a one-line factual question) doesn't pay for a classify
 * call it was never going to need. Deliberately conservative: per explicit
 * direction, a false "skip" (treating a genuinely compound request as
 * simple, silently losing whatever part the classifier would have caught)
 * is a real regression, while an unnecessary classifier call is only ever
 * a latency/cost cost — so this only ever fires `'skip'` on an
 * unambiguous, short, single-clause message, and defers to the real
 * classifier (`'run'`) on anything even plausibly compound. It never
 * decides "compound" itself — only whether the real check is worth
 * skipping.
 */
export type ClassifyGateVerdict = 'skip' | 'run'

/** Above this length, a message is assumed more likely to contain a bundled multi-part request — kept short and conservative on purpose. */
const MAX_SKIP_LENGTH = 50

/** Any of these, or a literal semicolon/newline, is treated as a plausible compound-request signal — matches the same connector words `buildClassifySystemPrompt` (orchestrator.ts) already asks the classifier itself to watch for. */
const COMPOUND_SIGNAL = /\b(and|then|also|after)\b|[;\n]/i

/** With a knowledge server connected, a short question is not safe to skip: "How do I set a default timeout in axios?" is 48 characters and needs the library-docs server. */
const MAX_SKIP_LENGTH_WITH_SERVERS = 25

export function evaluateClassifyGate(latestMessageText: string, options: { knowledgeServers?: boolean } = {}): ClassifyGateVerdict {
  const text = latestMessageText.trim()
  if (text.length === 0 || text.length > MAX_SKIP_LENGTH) return 'run'
  if (options.knowledgeServers && (text.length > MAX_SKIP_LENGTH_WITH_SERVERS || text.includes('?'))) return 'run'
  if (COMPOUND_SIGNAL.test(text)) return 'run'
  // More than one sentence-ending mark suggests multiple distinct asks
  // bundled into one message even without an explicit connector word (e.g.
  // "What's the weather? Also book a table.").
  const sentenceEnders = (text.match(/[.?!]/g) ?? []).length
  if (sentenceEnders > 1) return 'run'
  return 'skip'
}

/**
 * Phase 2 of #95 — even when the gate says `'skip'`, this fraction of the
 * time the real classifier still runs anyway, purely so its actual output
 * can be logged alongside the gate's verdict (see `db/classify-gate-log.ts`)
 * and the gate's real-world accuracy measured over time, before ever
 * widening what it's allowed to skip. This never changes what happens with
 * the result — a sampled call's real classifier output is used exactly as
 * normal; only the (gate verdict, real verdict) pair is additionally logged.
 */
const CALIBRATION_SAMPLE_RATE = 0.15

export function shouldSampleForCalibration(random: () => number = Math.random): boolean {
  return random() < CALIBRATION_SAMPLE_RATE
}
