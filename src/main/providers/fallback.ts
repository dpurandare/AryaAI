/**
 * TASKS #225: when the user's own Ollama is the chat provider and is not running, an explicitly configured CLOUD model can answer
 * that one turn instead. It sends the conversation off the machine, so it only ever applies with the user's recorded consent,
 * never switches the active provider, and the chat always says that it happened.
 */
export interface FallbackConfig {
  providerId?: string
  model?: string
  consent: boolean
}

export interface FallbackTarget {
  providerId: string
  displayName: string
  model: string
}

/**
 * The fallback that would really be used, or undefined: it needs consent, a provider and a model, the provider must be a hosted one
 * (it needs an API key: a second local model would not help when Ollama itself is down) and must have its key configured.
 */
export function usableFallback(
  config: FallbackConfig,
  lookup: (providerId: string) => { displayName: string; requiresApiKey: boolean } | undefined,
  hasKey: (providerId: string) => boolean
): FallbackTarget | undefined {
  const { providerId, model } = config
  if (!config.consent || !providerId || !model) return undefined
  const descriptor = lookup(providerId)
  if (!descriptor || !descriptor.requiresApiKey || providerId === 'ollama' || !hasKey(providerId)) return undefined
  return { providerId, displayName: descriptor.displayName, model }
}

/** The warning line shown in the chat (and kept in its history) whenever the fallback answers. */
export function fallbackNotice(target: FallbackTarget): string {
  return (
    `Ollama (local) is not running, so this answer came from ${target.displayName} ${target.model}. ` +
    `Your conversation was sent to ${target.displayName}.`
  )
}
