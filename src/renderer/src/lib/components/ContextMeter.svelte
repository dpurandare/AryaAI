<script lang="ts">
  import { contextWindowFor, estimateCost } from '@shared/model-metadata'

  let {
    model,
    inputTokens,
    outputTokens
  }: {
    model: string
    inputTokens: number
    outputTokens: number
  } = $props()

  const totalTokens = $derived(inputTokens + outputTokens)
  const contextWindow = $derived(contextWindowFor(model))
  const usedFraction = $derived(contextWindow.tokens > 0 ? totalTokens / contextWindow.tokens : 0)
  const warning = $derived(usedFraction >= 0.8)
  const cost = $derived(estimateCost(model, inputTokens, outputTokens))

  function formatCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return String(n)
  }
</script>

<span class="context-meter" class:warning title="Cumulative tokens used this session vs. the current model's context window">
  <span class="dot"></span>
  {formatCount(totalTokens)} / {contextWindow.isEstimate ? '~' : ''}{formatCount(contextWindow.tokens)} tokens
  {#if cost !== undefined}
    · ~${cost < 0.01 && cost > 0 ? '<0.01' : cost.toFixed(2)}
  {/if}
</span>

<style>
  .context-meter {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.72rem;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
  }
  .context-meter.warning {
    color: var(--warn);
    border-color: var(--warn);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
  }
  .context-meter.warning .dot {
    background: var(--warn);
  }
</style>
