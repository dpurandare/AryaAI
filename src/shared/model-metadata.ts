/**
 * Static, hand-maintained model metadata — context windows and pricing.
 * None of the 4 provider APIs reliably expose both of these for every model
 * they serve (Gemini's `models.list()` does return context limits; the
 * others don't), so this is a best-effort table, not a live source of
 * truth. Pricing especially will drift — treat it as approximate and keep
 * it updated by hand rather than trusting it blindly.
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
  { prefix: 'o3', tokens: 128_000 }
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

interface PriceEntry {
  prefix: string
  input: number
  output: number
}

/** USD per 1M tokens. Only models with real, confident pricing are listed — everything else resolves to `undefined` rather than a guess. */
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
