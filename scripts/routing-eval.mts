/**
 * Slim-router release gates 1 and 2 (docs/design-discussion.md section 10, step 4) — the two that need a real model.
 *
 *   routing evaluation (gate 2):  the manifest's examples / non-examples replayed against a provider with the
 *                                 router's real prompt and tool list. Non-deterministic: run it per model, a few times.
 *   replay probe (gate 1):        does this provider accept a history containing a call to a tool that is not in the
 *                                 request's tool list — raw, and the collapsed form the slim router actually sends?
 *
 * Usage (keys come from the environment; nothing is stored or printed):
 *
 *   ANTHROPIC_API_KEY=... npx vite-node --config vitest.config.ts scripts/routing-eval.mts -- anthropic claude-haiku-4-5-20251001
 *   OPENAI_API_KEY=...    npx vite-node --config vitest.config.ts scripts/routing-eval.mts -- openai gpt-5-mini --full      # compare against the full-registry router
 *   MISTRAL_API_KEY=...   npx vite-node --config vitest.config.ts scripts/routing-eval.mts -- mistral codestral-latest --probe-only
 *   npx vite-node --config vitest.config.ts scripts/routing-eval.mts -- ollama llama3.1 --dry                                # build everything, call no model
 *
 * Rate limits (Groq, Mistral, any free tier): --pace-ms=N (min gap between calls), --tpm=N (tokens per minute budget, from actual usage), --max-wait-s=N
 * (longest wait accepted before the run stops as "quota window"; default 120), --from=N (resume at case N), or plain --pace to only wait out 429s.
 *
 * Flags: --core=a,b,c (slim router with exactly that hot core instead of the default), --full (evaluate the full-registry router instead of the slim one), --probe-only, --skip-probe, --rounds=N (answer exploration tools and let the model continue, default 1), --dry, --limit=N (an evenly
 * spread subset — a 27B local model takes ~50 s per case). Progress is printed per case, so a long run can be cut short and still read.
 * Keys: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY (or GEMINI_API_KEY), GROQ_API_KEY, MISTRAL_API_KEY. Ollama needs none.
 *
 * To use a key you already configured in Sachivji (nothing to export or paste), wrap the command with the helper — it decrypts the key in
 * memory, gives it only to the child process, and redacts it from all output:
 *
 *   ./node_modules/electron/dist/electron --no-sandbox scripts/with-app-key.cjs google -- \
 *       npx vite-node --config vitest.config.ts scripts/routing-eval.mts -- google gemini-3.5-flash --rounds=3
 *
 * Read the result with care: it is ONE sample of a non-deterministic model on 43 cases (differences of a few cases are noise), the "explored
 * first" figure counts requests where the model looked around (listed a folder, asked what it can do) before deciding — extra rounds even
 * when it ends up right — the two mcp-operator cases cannot pass here because no MCP server is connected in this harness, and a CLARIFYING
 * QUESTION ("which file?", "please provide the rows") is scored as a miss although it is often the right answer to an underspecified case;
 * the excerpt printed after "answered directly" lets you tell the two apart.
 */
import { AnthropicProvider } from '../src/main/providers/anthropic'
import { GoogleProvider } from '../src/main/providers/google'
import { GroqProvider } from '../src/main/providers/groq'
import { MistralProvider } from '../src/main/providers/mistral'
import { OllamaProvider } from '../src/main/providers/ollama'
import { OpenAIProvider } from '../src/main/providers/openai'
import type { ModelProvider } from '../src/main/providers/types'
import { buildCapabilities, createDescribeCapabilitiesTool } from '../src/main/agents/capabilities'
import { Orchestrator } from '../src/main/agents/orchestrator'
import { createAgents } from '../src/main/agents/roles'
import { ROUTER_CORE_TOOLS, selectRouterTools } from '../src/main/agents/router-tools'
import { SYSTEM_PROMPT } from '../src/main/agents/system-prompt'
import { isFatalProviderError, withPacing } from '../src/main/agents/paced-provider'
import { buildRoutingCases, describeChoice, formatRoutingReport, replayProbeHistory, runReplayProbe, runRoutingEval, summarizeOutcomes, type EvalSetup, type RoutingOutcome } from '../src/main/agents/routing-eval'
import { collapseUnavailableToolCalls } from '../src/main/context/prepare-context'
import { createDefaultRegistry } from '../src/main/tools/setup'

const [providerId, model, ...flags] = process.argv.slice(2)
if (!providerId || !model) {
  console.error('usage: npx vite-node --config vitest.config.ts scripts/routing-eval.mts -- <provider> <model> [--full] [--probe-only] [--dry]')
  process.exit(2)
}
const has = (f: string): boolean => flags.includes(f)
const num = (name: string): number | undefined => {
  const f = flags.find((x) => x.startsWith(`--${name}=`))
  return f ? Number(f.slice(name.length + 3)) : undefined
}
const rounds = Number(flags.find((f) => f.startsWith('--rounds='))?.slice('--rounds='.length) ?? 1)

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
      console.error(`Unknown provider "${id}". One of: anthropic, openai, google, groq, mistral, ollama.`)
      process.exit(2)
  }
}

// The router exactly as the app builds it (ipc/register.ts), minus live connections (none configured here).
const registry = createDefaultRegistry()
const agents = createAgents(registry)
registry.register(
  createDescribeCapabilitiesTool({
    getAgents: () => agents,
    getRegistry: () => registry,
    getConnections: () => ({ databases: [], apis: [], email: [] }),
    getRuntime: () => undefined
  })
)
// --core=a,b,c evaluates a slim router whose hot core is exactly that list (default: ROUTER_CORE_TOOLS) — for trying core variants without code changes.
const coreFlag = flags.find((f) => f.startsWith('--core='))
const core = coreFlag ? new Set(coreFlag.slice('--core='.length).split(',').filter(Boolean)) : undefined
const slimTools = selectRouterTools(registry.list(), agents)
const routerTools = has('--full')
  ? registry.list()
  : core
    ? slimTools.filter((t) => core.has(t.name) || !(ROUTER_CORE_TOOLS as readonly string[]).includes(t.name))
    : slimTools
const orchestrator = new Orchestrator(
  {} as never, model, agents, SYSTEM_PROMPT, routerTools, (async () => ({ approved: false })) as never,
  { workspaceGuard: { root: process.cwd() }, currentSessionId: 'eval' } as never, new AbortController().signal, { planningEnabled: false }
) as unknown as { buildOrchestratorSystemPrompt(): string; buildDelegateToolDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }

const owner = new Map<string, string>()
for (const a of agents.values()) for (const t of a.tools) if (!owner.has(t.name)) owner.set(t.name, a.role)
// With --rounds=N > 1, exploration tools are ANSWERED (not scored) so a model that looks around first is judged on where it goes next.
// describe_capabilities returns the real generated text; the folder listing and file contents below are a small fixed FAKE workspace.
const FAKE_LISTING = ['notes.txt', 'sales_2024.csv', 'report.md', 'analysis.py', 'invoice_template.docx', 'budget.xlsx', 'code/', 'documents/', 'resources/'].join('\n')
const infoTools: EvalSetup['infoTools'] =
  rounds > 1
    ? {
        describe_capabilities: () => buildCapabilities({ agents, registry, connections: { databases: [{ name: 'Northwind', engine: 'sqlite' }], apis: [], email: [{ name: 'Work', emailAddress: 'me@example.com', isDefault: true }] }, runtime: { status: 'ready', packages: 'installed', message: '', pythonVersion: '3.12', root: process.cwd() }, workspaceRoot: process.cwd() }),
        list_directory: () => FAKE_LISTING,
        read_file: (input) => (String(input.path ?? '').endsWith('notes.txt') ? 'Meeting notes: Q3 targets agreed. Follow up with finance.' : `Error: no such file "${String(input.path ?? '')}".`)
      }
    : undefined
const setup: EvalSetup = {
  infoTools,
  system: orchestrator.buildOrchestratorSystemPrompt(),
  tools: [...routerTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), ...orchestrator.buildDelegateToolDefinitions()],
  toolOwner: (n) => owner.get(n)
}

const limitFlag = flags.find((f) => f.startsWith('--limit='))
const limit = limitFlag ? Number(limitFlag.slice('--limit='.length)) : undefined
// An evenly spread subset, so a --limit run still covers many roles rather than just the first few.
const all = buildRoutingCases()
const spread = limit ? all.filter((_, i) => i % Math.max(1, Math.floor(all.length / limit)) === 0).slice(0, limit) : all
// --from=N resumes at case N (1-based) — after a run ended on a daily quota, continue tomorrow without repeating the finished cases.
const firstCase = (num('from') ?? 1) - 1
const cases = spread.slice(firstCase)
console.log(`Router: ${has('--full') ? 'FULL registry' : 'SLIM'} — ${routerTools.length} direct tools + ${orchestrator.buildDelegateToolDefinitions().length} delegate tools; ${cases.length} routing cases; up to ${rounds} round(s) per case${rounds > 1 ? ' (exploration tools answered from a fake workspace)' : ''}.`)
if (has('--dry')) {
  for (const c of cases) console.log(`  [${c.kind}] → ${c.expectedRole}: ${c.prompt}`)
  console.log('--dry: no model was called.')
  process.exit(0)
}

// Free / low tiers (Groq, Mistral) limit call frequency, tokens per minute and request size: --pace-ms spaces calls, --tpm keeps a sliding
// one-minute token budget from ACTUAL usage, and a 429 is waited out as the provider asks. A request that can never fit, or a daily quota
// that asks for hours, ends the run and prints what was measured so far (resume with --from=N).
const pace = num('pace-ms') !== undefined || num('tpm') !== undefined || has('--pace')
const paced = pace
  ? withPacing(makeProvider(providerId), {
      minIntervalMs: num('pace-ms'),
      tokensPerMinute: num('tpm'),
      maxWaitMs: (num('max-wait-s') ?? 120) * 1000,
      maxRetries: num('max-retries'),
      onWait: (ms, why) => console.error(`  … waiting ${(ms / 1000).toFixed(1)}s (${why})`)
    })
  : undefined
const provider = paced ?? makeProvider(providerId)
const finished: RoutingOutcome[] = []
function printPacing(): void {
  if (paced) console.log(`\nPacing: ${paced.stats.calls} calls, ${paced.stats.retries} rate-limit retries, ${(paced.stats.waitedMs / 1000).toFixed(0)}s spent waiting.`)
}
function stopOnLimit(err: unknown): never {
  if (!isFatalProviderError(err)) throw err
  console.log(`\nSTOPPED by a provider limit: ${err.message}`)
  if (finished.length) console.log('\nPartial result (' + finished.length + ' cases finished before the limit):\n' + formatRoutingReport(summarizeOutcomes(providerId, model, finished)))
  printPacing()
  console.log(`Resume with --from=${firstCase + finished.length + 1} once the limit allows.`)
  process.exit(3)
}

if (!has('--skip-probe')) {
console.log('\nReplay probe (gate 1) — history contains a completed call to xlsx_write, which is NOT in the request tool list:')
const raw = replayProbeHistory()
const probeTools = setup.tools.filter((t) => t.name === 'shell_execute' || t.name === 'read_file')
for (const r of await runReplayProbe(provider, model, raw, collapseUnavailableToolCalls(raw, new Set(probeTools.map((t) => t.name))), probeTools).catch(stopOnLimit)) {
  console.log(`  ${r.variant.padEnd(10)} ${r.accepted ? 'accepted' : 'REJECTED'}${r.error ? ` — ${r.error.slice(0, 200)}` : ''}`)
}
}

if (!has('--probe-only')) {
  console.log('\nRouting evaluation (gate 2) — first round only, no tools executed:')
  const report = await runRoutingEval(provider, model, setup, cases, undefined, rounds, (o, i, n) => {
    finished.push(o)
    console.log(`  ${String(i + 1 + firstCase).padStart(2)}/${n + firstCase} ${o.correct ? 'ok  ' : 'MISS'} [${o.case.kind}] "${o.case.prompt.slice(0, 70)}" → expected ${o.case.expectedRole}, got ${describeChoice(o.choice)}${o.explored.length ? ` (after ${o.explored.join(', ')})` : ''}`)
  }).catch(stopOnLimit)
  console.log('\n' + formatRoutingReport(report))
  printPacing()
}
