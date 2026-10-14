<script lang="ts">
  import { contextWindowFor, estimateCost } from '@shared/model-metadata'
  import { contextLabel, contextWarning, formatCount } from '../context-meter'

  let {
    model,
    inputTokens,
    outputTokens,
    contextTokens = null,
    contextWindow: liveContextWindow = null
  }: {
    model: string
    /** Summed over every request this session: what was sent and received, which is what costs money. */
    inputTokens: number
    outputTokens: number
    /** What the latest top-level request held (input plus reply), or null before the first one this run. This is what has to fit in the window. */
    contextTokens?: number | null
    /** The real per-turn value from a `context_window` stream event, once at least one message has been sent this session — see App.svelte's SessionRuntime. Null before that, in which case this falls back to the same static guess it always used. */
    contextWindow?: { tokens: number; isEstimate: boolean } | null
  } = $props()

  const totalTokens = $derived(inputTokens + outputTokens)
  const contextWindow = $derived(liveContextWindow ?? contextWindowFor(model))
  const warning = $derived(contextWarning(contextTokens, contextWindow.tokens))
  const cost = $derived(estimateCost(model, inputTokens, outputTokens))
</script>

<span
  class="context-meter"
  class:warning
  title={`ctx: what the latest request held, against the model's window. Σ: all tokens sent and received this session (${formatCount(inputTokens)} in, ${formatCount(outputTokens)} out); every round re-sends the conversation, so it grows much faster than ctx.`}
>
  <span class="dot"></span>
  {contextLabel(contextTokens, contextWindow.tokens, contextWindow.isEstimate)} · Σ {formatCount(totalTokens)}
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
