/**
 * Static, hand-maintained model metadata — context windows, per-call output
 * ceilings, and pricing. None of the 4 provider APIs reliably expose all of
 * these for every model they serve (Gemini's `models.list()` does return
 * context limits; the others don't), so this is a best-effort table, not a
 * live source of truth. All of it will drift over time — treat it as
 * approximate and keep it updated by hand rather than trusting it blindly.
 */

// Ollama model ids are the only ones shaped "name:tag" (e.g. "gpt-oss:20b")
// across all 4 providers. Checked first everywhere below, or a local model
// like "gpt-oss:20b" would wrongly match the cloud "gpt-" prefix.
function isLocalModelId(model: string): boolean {
  return /^[\w.-]+:[\w.]+$/.test(model)
}

interface ContextWindowEntry {
  prefix: string
  tokens: number
}

const CONTEXT_WINDOWS: ContextWindowEntry[] = [
  { prefix: 'claude-', tokens: 200_000 },
  { prefix: 'gemini-', tokens: 1_048_576 },
  { prefix: 'gpt-', tokens: 128_000 },
  { prefix: 'o1', tokens: 128_000 },
  { prefix: 'o3', tokens: 128_000 },
  // Groq-hosted models (TASKS.md #90) — confirmed against console.groq.com/docs/models,
  // not guessed. 'openai/gpt-oss-*' (Groq's own hosting of the open-weight GPT-OSS
  // models) is a distinct id shape from real OpenAI's 'gpt-*' above, so it needs its
  // own entry rather than colliding with — or being shadowed by — that one.
  { prefix: 'llama-', tokens: 131_072 },
  { prefix: 'openai/gpt-oss', tokens: 131_072 }
]

/**
 * Every local Ollama model lands here when no live reading is available
 * (see providers/ollama.ts's `loadedContextWindow` — main/context/
 * prepare-context.ts prefers that whenever the model is currently loaded,
 * and only falls back to this static guess for a cold model). Deliberately
 * conservative — Ollama's own most commonly observed runtime default when
 * a model doesn't set `num_ctx` explicitly (confirmed live: gpt-oss:20b,
 * which advertises a 131072-token architectural max, was actually loaded
 * at exactly this). Erring small here is the safe direction: an
 * *underestimate* just trims a bit more history than strictly necessary;
 * an *overestimate* is what let a prompt reach the server's real, smaller
 * limit and get silently truncated mid-turn with zero visible output —
 * the exact bug this constant exists to avoid repeating.
 */
const DEFAULT_LOCAL_CONTEXT_WINDOW = 4_096

/** Generic fallback for an unrecognized *cloud* model id only — real cloud context windows are typically far larger than a local model's, so this stays a separate, more generous constant rather than sharing one with the local fallback above. */
const DEFAULT_CONTEXT_WINDOW = 8_192

export interface ContextWindowInfo {
  tokens: number
  /** True when this came from a fallback, not a real per-model entry. */
  isEstimate: boolean
}

export function contextWindowFor(model: string): ContextWindowInfo {
  if (isLocalModelId(model)) return { tokens: DEFAULT_LOCAL_CONTEXT_WINDOW, isEstimate: true }
  const match = CONTEXT_WINDOWS.find((entry) => model.startsWith(entry.prefix))
  return match ? { tokens: match.tokens, isEstimate: false } : { tokens: DEFAULT_CONTEXT_WINDOW, isEstimate: true }
}

interface MaxOutputEntry {
  prefix: string
  tokens: number
}

/**
 * Real, provider-enforced per-call output ceilings (distinct from
 * CONTEXT_WINDOWS above, which is the *input* side) — confirmed against
 * each provider's own current documentation, not guessed. This used to not
 * exist at all: every round's `maxTokens` was a single flat `4096` for
 * every provider, model, and round, unrelated to any of these real numbers
 * (found live, 2026-09-13 — Claude Sonnet 5/Opus 5 alone allow 128,000,
 * meaning ordinary Claude replies in this app had been capped to ~3% of
 * their real ceiling since the orchestrator was first built). More specific
 * prefixes (`claude-opus`, `claude-sonnet`, `claude-haiku`) must come before
 * any future generic `claude-` entry, matching the PRICES table's ordering
 * convention below.
 */
const MAX_OUTPUT_TOKENS: MaxOutputEntry[] = [
  { prefix: 'claude-opus', tokens: 128_000 },
  { prefix: 'claude-sonnet', tokens: 128_000 },
  { prefix: 'claude-haiku', tokens: 64_000 },
  // Reasoning models: hidden chain-of-thought tokens count against this
  // same budget before any visible output is produced (confirmed: o1 can
  // spend up to ~100K reasoning tokens before its completion limit even
  // applies) — the identical failure class found live against gpt-oss, just
  // on a cloud provider. o1-preview's real documented ceiling is ~32K;
  // o3's isn't independently confirmed as of this writing, so it's treated
  // as at least as reasoning-heavy as o1 and given the same generous
  // headroom rather than guessed lower (see `isEstimate` on the return).
  { prefix: 'o1', tokens: 32_000 },
  { prefix: 'o3', tokens: 100_000 },
  { prefix: 'gpt-', tokens: 16_384 }, // gpt-4o family
  { prefix: 'gemini-', tokens: 64_000 },
  // Groq-hosted models (TASKS.md #90), confirmed against console.groq.com/docs/models.
  // Specific ids before the generic 'llama-' fallback, same ordering convention as
  // claude-opus/sonnet/haiku above — llama-3.1-8b-instant and llama-3.3-70b-versatile
  // have genuinely different real ceilings, not a shared family default.
  { prefix: 'llama-3.1-8b', tokens: 131_072 },
  { prefix: 'llama-3.3-70b', tokens: 32_768 },
  { prefix: 'llama-', tokens: 32_768 }, // conservative fallback for any other/future Groq Llama model
  { prefix: 'openai/gpt-oss', tokens: 65_536 }
]

/** Ollama has no real per-call rejection risk the way a commercial API does (no fixed registered ceiling to validate against) — a generous default here is safe, and orchestrator.ts's live `loadedContextWindow` reading already scales the *actual* per-round budget down from this when a smaller real context is loaded. */
const DEFAULT_LOCAL_MAX_OUTPUT_TOKENS = 32_768

/** Conservative fallback for a cloud model id this table doesn't recognize — matches this app's original flat value, kept as the safe floor for exactly the case it was always used for (an unknown model), not as the default for every model as it used to be. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096

export function maxOutputTokensFor(model: string): ContextWindowInfo {
  if (isLocalModelId(model)) return { tokens: DEFAULT_LOCAL_MAX_OUTPUT_TOKENS, isEstimate: true }
  const match = MAX_OUTPUT_TOKENS.find((entry) => model.startsWith(entry.prefix))
  return match ? { tokens: match.tokens, isEstimate: false } : { tokens: DEFAULT_MAX_OUTPUT_TOKENS, isEstimate: true }
}

interface PriceEntry {
  prefix: string
  input: number
  output: number
}

/**
 * USD per 1M tokens. Only models with real, confident pricing are listed —
 * everything else resolves to `undefined` rather than a guess (see
 * `pricePerMillionTokens`'s own "cost unknown" fallback).
 *
 * Groq (TASKS.md #90) deliberately has no entries here: its self-serve
 * pricing moved around materially as recently as 2026-08-26 (llama-3.1-8b-
 * instant/llama-3.3-70b-versatile reportedly moved to enterprise-only
 * "contact sales" pricing, dropping off the public rate table), and no
 * current, first-party numbers were confirmed directly from Groq's own docs
 * at implementation time — only third-party aggregator pages, which this
 * table's own policy treats as not confident enough to list. Revisit once
 * real, current pricing can be confirmed against Groq's own pricing page.
 */
const PRICES: PriceEntry[] = [
  { prefix: 'claude-opus', input: 15, output: 75 },
  { prefix: 'claude-sonnet', input: 3, output: 15 },
  { prefix: 'claude-haiku', input: 0.8, output: 4 },
  { prefix: 'gpt-4o-mini', input: 0.15, output: 0.6 },
  { prefix: 'gpt-4o', input: 2.5, output: 10 },
  { prefix: 'gemini-flash-lite', input: 0.1, output: 0.4 },
  { prefix: 'gemini-flash', input: 0.3, output: 2.5 },
  { prefix: 'gemini-pro', input: 1.25, output: 10 }
]

export function pricePerMillionTokens(model: string): { input: number; output: number } | undefined {
  if (isLocalModelId(model)) return { input: 0, output: 0 } // local compute, genuinely free
  const match = PRICES.find((entry) => model.startsWith(entry.prefix))
  return match ? { input: match.input, output: match.output } : undefined
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number | undefined {
  const price = pricePerMillionTokens(model)
  if (!price) return undefined
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000
}
