/** The status-bar meter: context in use against the window, the session's total tokens, and the estimated cost. */

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** Share of the window held by the latest request; 0 when nothing has been measured yet or the window is unknown. */
export function contextFraction(contextTokens: number | null, windowTokens: number): number {
  return contextTokens !== null && windowTokens > 0 ? contextTokens / windowTokens : 0
}

/** The warning colour is about the context only: the session total keeps growing by design (every round re-sends the conversation). */
export function contextWarning(contextTokens: number | null, windowTokens: number): boolean {
  return contextFraction(contextTokens, windowTokens) >= 0.8
}

/** "ctx 38.0K / 200.0K"; a dash before the first request of the session (nothing measured, and a reloaded session has no live reading). */
export function contextLabel(contextTokens: number | null, windowTokens: number, isEstimate: boolean): string {
  return `ctx ${contextTokens === null ? '–' : formatCount(contextTokens)} / ${isEstimate ? '~' : ''}${formatCount(windowTokens)}`
}
