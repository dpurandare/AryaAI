/**
 * TASKS #215: does each pinned specialist state its own role (and abilities) when greeted, on a fresh one-message conversation?
 * Prints one line per role and prompt; "ok" means the reply names the role's own label, shows at least one of its tools by name (a greeting),
 * and does not end with the generic offer. A non-greeting prompt must NOT get an introduction (#232).
 *
 *   npx vite-node --config vitest.config.ts scripts/greeting-probe.mts -- ollama qwen3.5:0.8b-custom
 */
import { roleLabel } from '../src/shared/agents'
import { OllamaProvider } from '../src/main/providers/ollama'
import { Orchestrator } from '../src/main/agents/orchestrator'
import { createAgents } from '../src/main/agents/roles'
import { SYSTEM_PROMPT } from '../src/main/agents/system-prompt'
import { createDefaultRegistry } from '../src/main/tools/setup'

const [, model = 'qwen3.5:0.8b-custom'] = process.argv.slice(2)
const registry = createDefaultRegistry()
const agents = createAgents(registry)
let ok = 0
let total = 0
let leaked = 0
for (const role of agents.keys()) {
  const label = roleLabel(role)
  for (const prompt of ['Hello', 'What can you do?']) {
    const orchestrator = new Orchestrator(new OllamaProvider(), model, agents, SYSTEM_PROMPT, registry.list(), (async () => ({ approved: false })) as never, { workspaceGuard: { root: process.cwd() }, currentSessionId: 'probe' } as never, new AbortController().signal, { planningEnabled: false })
    let text = ''
    for await (const e of orchestrator.run([{ role: 'user', content: [{ type: 'text', text: prompt }] }], role as never)) {
      if (e.kind === 'stream' && e.event.type === 'text_delta') text += e.event.text
    }
    const toolNames = (agents.get(role)?.tools ?? []).map((t) => t.name)
    const shows = toolNames.length === 0 || toolNames.some((n) => text.includes(n))
    const generic = /how can i assist you today/i.test(text)
    const names = text.toLowerCase().includes(label.toLowerCase().split(' ')[0]) && shows && !generic
    total++
    if (names) ok++
    console.log(`${names ? 'ok ' : 'BAD'} ${label.padEnd(22)} ${prompt.padEnd(17)} | ${text.slice(0, 140).replace(/\n/g, ' ')}`)
  }
}
// A request that is not a greeting must be answered (or handed over) without an introduction.
for (const role of agents.keys()) {
  const orchestrator = new Orchestrator(new OllamaProvider(), model, agents, SYSTEM_PROMPT, registry.list(), (async () => ({ approved: false })) as never, { workspaceGuard: { root: process.cwd() }, currentSessionId: 'probe' } as never, new AbortController().signal, { planningEnabled: false })
  let text = ''
  for await (const e of orchestrator.run([{ role: 'user', content: [{ type: 'text', text: 'Compare Python and Rust in two sentences.' }] }], role as never)) {
    if (e.kind === 'stream' && e.event.type === 'text_delta') text += e.event.text
  }
  const intro = /\b(i'?m|i am) the\b[^.]{0,40}\b(specialist|agent)\b|my main abilities/i.test(text)
  if (intro) leaked++
  console.log(`${intro ? 'INTRO' : 'ok   '} ${roleLabel(role).padEnd(22)} non-greeting | ${text.slice(0, 140).replace(/\n/g, ' ')}`)
}
console.log(`\n${ok} of ${total} greeting replies are good (role named, a tool shown, no generic offer); ${leaked} non-greeting replies introduced themselves`)
process.exit(0)
