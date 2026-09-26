/**
 * Slim-router / caching release gate 3 (design-discussion.md section 10): what does prompt size and a byte-stable prefix
 * actually do on a real provider? Sends the SAME router request (the app's real system prompt + tool list) several times and
 * prints, per call: time to first token, total time, input tokens, and how many of them were served from the provider's cache.
 *
 *   ANTHROPIC_API_KEY=... npx vite-node --config vitest.config.ts scripts/cache-probe.mts -- anthropic claude-haiku-4-5-20251001
 *   OPENAI_API_KEY=...    npx vite-node --config vitest.config.ts scripts/cache-probe.mts -- openai gpt-5-mini --full
 *   npx vite-node --config vitest.config.ts scripts/cache-probe.mts -- ollama qwen3.8-custom:latest --calls=3
 *
 * Flags: --full (the full-registry router instead of the slim one), --calls=N (default 3), --dry (build the request, call nothing).
 * Reading the result: call 1 pays for the prefix (and, on Anthropic, writes the cache); calls 2..N should show a large cached share
 * and a lower time to first token. If "cached" stays 0 on Anthropic/OpenAI the prefix is not stable, or is under the provider's
 * minimum (about 1,024 tokens). Ollama reports no cache figure — read its time to first token instead. Keys come from the environment.
 */
import { AnthropicProvider } from '../src/main/providers/anthropic'
import { GoogleProvider } from '../src/main/providers/google'
import { GroqProvider } from '../src/main/providers/groq'
import { MistralProvider } from '../src/main/providers/mistral'
import { OllamaProvider } from '../src/main/providers/ollama'
import { OpenAIProvider } from '../src/main/providers/openai'
import type { ModelProvider } from '../src/main/providers/types'
import { createDescribeCapabilitiesTool } from '../src/main/agents/capabilities'
import { Orchestrator } from '../src/main/agents/orchestrator'
import { createAgents } from '../src/main/agents/roles'
import { selectRouterTools } from '../src/main/agents/router-tools'
import { SYSTEM_PROMPT } from '../src/main/agents/system-prompt'
import { createDefaultRegistry } from '../src/main/tools/setup'

const [providerId, model, ...flags] = process.argv.slice(2)
if (!providerId || !model) {
  console.error('usage: npx vite-node --config vitest.config.ts scripts/cache-probe.mts -- <provider> <model> [--full] [--calls=N] [--dry]')
  process.exit(2)
}
const has = (f: string): boolean => flags.includes(f)
const calls = Number(flags.find((f) => f.startsWith('--calls='))?.slice('--calls='.length) ?? 3)

function key(...names: string[]): string {
  for (const n of names) if (process.env[n]) return process.env[n] as string
  console.error(`Set ${names.join(' or ')} in the environment.`)
  process.exit(2)
}
function makeProvider(id: string): ModelProvider {
  switch (id) {
    case 'anthropic': return new AnthropicProvider(key('ANTHROPIC_API_KEY'))
    case 'openai': return new OpenAIProvider(key('OPENAI_API_KEY'))
    case 'google': return new GoogleProvider(key('GOOGLE_API_KEY', 'GEMINI_API_KEY'))
    case 'groq': return new GroqProvider(key('GROQ_API_KEY'))
    case 'mistral': return new MistralProvider(key('MISTRAL_API_KEY'))
    case 'ollama': return new OllamaProvider()
    default:
      console.error(`Unknown provider "${id}".`)
      process.exit(2)
  }
}

const registry = createDefaultRegistry()
const agents = createAgents(registry)
registry.register(createDescribeCapabilitiesTool({ getAgents: () => agents, getRegistry: () => registry, getConnections: () => ({ databases: [], apis: [], email: [] }), getRuntime: () => undefined }))
const routerTools = has('--full') ? registry.list() : selectRouterTools(registry.list(), agents)
const orchestrator = new Orchestrator({} as never, model, agents, SYSTEM_PROMPT, routerTools, (async () => ({ approved: false })) as never, { workspaceGuard: { root: process.cwd() }, currentSessionId: 'probe' } as never, new AbortController().signal, { planningEnabled: false }) as unknown as {
  buildOrchestratorSystemPrompt(): string
  buildDelegateToolDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
}
const system = orchestrator.buildOrchestratorSystemPrompt()
const tools = [...routerTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), ...orchestrator.buildDelegateToolDefinitions()]
console.log(`Router: ${has('--full') ? 'FULL registry' : 'SLIM'}; ${tools.length} tools; ${calls} identical calls to ${providerId} / ${model}.`)
if (has('--dry')) process.exit(0)

const provider = makeProvider(providerId)
for (let i = 1; i <= calls; i++) {
  const t0 = performance.now()
  let ttft: number | undefined
  let input = 0
  let cached = 0
  let outTokens = 0
  try {
    for await (const ev of provider.stream({ model, system, tools, messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: ok' }] }], maxTokens: 16 })) {
      ttft ??= performance.now() - t0
      if (ev.type === 'usage') {
        input = ev.inputTokens
        outTokens = ev.outputTokens
        cached = ev.cacheReadTokens ?? cached
      }
    }
    console.log(`  call ${i}: first token ${((ttft ?? 0) / 1000).toFixed(1)}s, total ${((performance.now() - t0) / 1000).toFixed(1)}s, input ${input}, cached ${cached}${input ? ` (${Math.round((cached / input) * 100)}%)` : ''}, output ${outTokens}`)
  } catch (err) {
    console.log(`  call ${i}: ERROR ${err instanceof Error ? err.message : String(err)}`)
  }
}
