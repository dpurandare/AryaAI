/**
 * How reliably does a model return a valid classify-and-plan reply — asked in the prompt only ("hoping"), versus with provider-enforced structured
 * output (a JSON schema)? Sends the app's real planning prompt for a fixed set of requests, in both modes, and counts per mode: replies that are
 * strictly valid JSON, replies `parsePlan` accepts (the loose parser: fence/prose tolerated, roles and shape checked), and the classification
 * matching what is expected (simple vs compound). The last is only a sanity check on eight requests whose answer is not in doubt.
 * A case with `expectRoles` (design-discussion.md §13.2(a), TASKS #142) also checks the plan's step roles match that exact set —
 * `complexity: "compound"` alone doesn't catch the PLF question's #139 failure mode, where it was compound but the wiki step went
 * missing or the roles varied between reps.
 *
 *   ./node_modules/electron/dist/electron --no-sandbox scripts/with-app-key.cjs google -- \
 *     npx vite-node --config vitest.config.ts scripts/plan-probe.mts -- google gemini-3.5-flash-lite --reps=2
 *   npx vite-node --config vitest.config.ts scripts/plan-probe.mts -- ollama gpt-oss-custom:latest --reps=2
 *
 * Flags: --reps=N (default 2), --max-tokens=N (default 4096), --timeout-s=N (per call, default 120; a timed-out call counts as an error), --only=plain|structured, --pace-ms=N / --tpm=N / --pace (free-tier pacing as in
 * routing-eval), --show (print each reply's first 160 characters).
 */
import { AnthropicProvider } from '../src/main/providers/anthropic'
import { GoogleProvider } from '../src/main/providers/google'
import { GroqProvider } from '../src/main/providers/groq'
import { MistralProvider } from '../src/main/providers/mistral'
import { OllamaProvider } from '../src/main/providers/ollama'
import { OpenAIProvider } from '../src/main/providers/openai'
import type { ModelProvider } from '../src/main/providers/types'
import { isFatalProviderError, withPacing } from '../src/main/agents/paced-provider'
import { buildPlanSchema, Orchestrator, parsePlan } from '../src/main/agents/orchestrator'
import { createAgents } from '../src/main/agents/roles'
import { SYSTEM_PROMPT } from '../src/main/agents/system-prompt'
import { createDefaultRegistry } from '../src/main/tools/setup'

const [providerId, model, ...flags] = process.argv.slice(2)
if (!providerId || !model) {
  console.error('usage: npx vite-node --config vitest.config.ts scripts/plan-probe.mts -- <provider> <model> [--reps=N] [--max-tokens=N] [--only=plain|structured] [--show]')
  process.exit(2)
}
const numFlag = (name: string): number | undefined => {
  const f = flags.find((x) => x.startsWith(`--${name}=`))
  return f ? Number(f.slice(name.length + 3)) : undefined
}
const strFlag = (name: string): string | undefined => flags.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3)
const reps = numFlag('reps') ?? 2
const maxTokens = numFlag('max-tokens') ?? 4096
const only = strFlag('only')
const timeoutS = numFlag('timeout-s') ?? 120

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

const CASES: Array<{ text: string; expect: 'simple' | 'compound'; expectRoles?: readonly string[] }> = [
  { text: 'What was the Plant Load Factor (PLF) for GJ01-WIND in 2024, and how does it compare to the P50 AEP target of 470 GWh/year? You may use the information from wiki and database to answer this question.', expect: 'compound', expectRoles: ['mcp-operator', 'data'] },
  { text: 'Get the monthly sales totals from the database and write them into a Word report.', expect: 'compound' },
  { text: 'Look up the latest news on offshore wind tariffs on the web, then compare it with our 2024 generation figures in the database.', expect: 'compound', expectRoles: ['research', 'data'] },
  { text: 'Query the top 10 customers by revenue, then create an Excel sheet with a chart of them.', expect: 'compound' },
  { text: 'What is the recommended maintenance interval for the GJ01-WIND inverter per the manufacturer guidance in the wiki, and how many operating hours has it logged in the database this year?', expect: 'compound', expectRoles: ['mcp-operator', 'data'] },
  { text: 'What is 17 times 23?', expect: 'simple' },
  { text: 'Explain what a plant load factor is.', expect: 'simple' },
  { text: 'List the files in my workspace.', expect: 'simple' },
  { text: 'How many customers are there in the northwind database?', expect: 'simple' }
]

const registry = createDefaultRegistry()
const agents = createAgents(registry)
const orch = new Orchestrator({} as never, model, agents, SYSTEM_PROMPT, registry.list(), (async () => ({ approved: false })) as never, { workspaceGuard: { root: process.cwd() }, currentSessionId: 'probe' } as never, new AbortController().signal, { planningEnabled: true }) as unknown as {
  buildClassifySystemPrompt(): string
  plannableRoleIds(): string[]
}
const system = orch.buildClassifySystemPrompt()
const roleIds = orch.plannableRoleIds()
const schema = buildPlanSchema(roleIds)
const validRoles = new Set(roleIds)

const paced = numFlag('pace-ms') !== undefined || numFlag('tpm') !== undefined || flags.includes('--pace')
const provider = paced
  ? withPacing(makeProvider(providerId), { minIntervalMs: numFlag('pace-ms'), tokensPerMinute: numFlag('tpm'), onWait: (ms, why) => console.error(`  … waiting ${(ms / 1000).toFixed(1)}s (${why})`) })
  : makeProvider(providerId)

interface Tally { calls: number; strictJson: number; validPlan: number; rightClass: number; roleChecks: number; rightRoles: number; errors: number; seconds: number }
const tallies: Record<string, Tally> = {}
const sameRoleSet = (got: readonly string[], want: readonly string[]): boolean => {
  const gotSet = new Set(got)
  return gotSet.size === want.length && want.every((r) => gotSet.has(r))
}
for (const mode of ['plain', 'structured'] as const) {
  if (only && only !== mode) continue
  const tally: Tally = (tallies[mode] = { calls: 0, strictJson: 0, validPlan: 0, rightClass: 0, roleChecks: 0, rightRoles: 0, errors: 0, seconds: 0 })
  console.log(`\n== ${mode} (${providerId} / ${model}, ${CASES.length} requests x ${reps}) ==`)
  outer: for (let r = 0; r < reps; r++) {
    for (const c of CASES) {
      const t0 = performance.now()
      let text = ''
      try {
        for await (const ev of provider.stream({
          model,
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: c.text }] }],
          maxTokens,
          signal: AbortSignal.timeout(timeoutS * 1000),
          ...(mode === 'structured' ? { structuredOutput: { name: 'classify_and_plan', schema } } : {})
        })) {
          if (ev.type === 'text_delta') text += ev.text
        }
      } catch (err) {
        tally.calls++
        tally.errors++
        console.log(`  ERROR ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
        if (isFatalProviderError(err)) break outer
        continue
      }
      tally.calls++
      tally.seconds += (performance.now() - t0) / 1000
      let strict = false
      try {
        JSON.parse(text.trim())
        strict = true
      } catch { /* not strictly JSON */ }
      const plan = parsePlan(text, validRoles)?.plan
      if (strict) tally.strictJson++
      if (plan) tally.validPlan++
      if (plan?.complexity === c.expect) tally.rightClass++
      let roleNote = ''
      if (c.expectRoles) {
        tally.roleChecks++
        const gotRoles = plan?.steps.map((s) => s.role) ?? []
        const rolesMatch = sameRoleSet(gotRoles, c.expectRoles)
        if (rolesMatch) tally.rightRoles++
        roleNote = ` roles=[${gotRoles.join(',')}] ${rolesMatch ? 'roles-ok' : `roles-WANT=[${c.expectRoles.join(',')}]`}`
      }
      console.log(`  ${plan ? 'ok ' : 'BAD'} ${((performance.now() - t0) / 1000).toFixed(1)}s [${c.expect}]${roleNote} ${flags.includes('--show') || !plan ? JSON.stringify(text.slice(0, 160)) : ''}`)
    }
  }
}
console.log('\nSummary (calls / strict JSON / valid plan / expected class / right roles (of role-checked cases) / errors / avg s):')
for (const [mode, t] of Object.entries(tallies)) {
  console.log(`  ${mode.padEnd(10)} ${t.calls} / ${t.strictJson} / ${t.validPlan} / ${t.rightClass} / ${t.rightRoles}/${t.roleChecks} / ${t.errors} / ${(t.seconds / Math.max(1, t.calls - t.errors)).toFixed(1)}s`)
}
