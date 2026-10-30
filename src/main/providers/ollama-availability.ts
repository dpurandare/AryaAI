/**
 * TASKS #214: is the user's own Ollama (the "Ollama (local)" chat provider) answering? A short, cached probe of its
 * `/api/version`, so the model selection can hide the provider when it is not running and Settings can say why,
 * without ever hanging the UI on a dead address.
 */
export interface OllamaReachability {
  reachable: boolean
  /** The address that was probed, as the root ("http://localhost:11434"), without /v1. */
  address: string
  /** Why it is not reachable, in plain words. Set only when `reachable` is false. */
  error?: string
}

const TIMEOUT_MS = 1500
const CACHE_MS = 5000

function rootOf(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '')
}

export class OllamaAvailability {
  private cache: { at: number; key: string; value: OllamaReachability } | undefined

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}

  /** The last result for this address, however old, or undefined if it has never been probed. Never waits. */
  peek(baseUrl: string): OllamaReachability | undefined {
    const address = rootOf(baseUrl)
    return this.cache?.key === address ? this.cache.value : undefined
  }

  /** `force` skips the cache (Settings "Check again"). Never rejects. */
  async check(baseUrl: string, force = false): Promise<OllamaReachability> {
    const address = rootOf(baseUrl)
    if (!force && this.cache && this.cache.key === address && this.now() - this.cache.at < CACHE_MS) return this.cache.value
    let value: OllamaReachability
    try {
      const res = await this.fetchImpl(`${address}/api/version`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      value = res.ok
        ? { reachable: true, address }
        : { reachable: false, address, error: `Something answered at ${address} but it did not look like Ollama (HTTP ${res.status}).` }
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      value = {
        reachable: false,
        address,
        error: timedOut
          ? `Nothing answered at ${address} within ${TIMEOUT_MS / 1000} seconds.`
          : `Could not connect to ${address}: Ollama does not seem to be running there.`
      }
    }
    this.cache = { at: this.now(), key: address, value }
    return value
  }
}
