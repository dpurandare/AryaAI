/**
 * Does each specialist, pinned in a conversation other specialists already answered in, answer as itself? Runs every role
 * pinned over a history of "Hello" replies by other roles (the 11.6 failure) and prints which role each reply names.
 *
 *   npx vite-node --config vitest.config.ts scripts/role-probe.mts -- ollama qwen3.5:9b-mlx-custom
 */
import { OllamaProvider } from '../src/main/providers/ollama'
import { Orchestrator } from '../src/main/agents/orchestrator'
import { createAgents } from '../src/main/agents/roles'
import { SYSTEM_PROMPT } from '../src/main/agents/system-prompt'
import { createDefaultRegistry } from '../src/main/tools/setup'
import type { Message } from '../src/main/providers/types'

const [, model = 'qwen3.5:9b-mlx-custom'] = process.argv.slice(2)
const registry = createDefaultRegistry()
const agents = createAgents(registry)
const roles: string[] = process.env.ONLY_AUTO ? [] : [...agents.keys()]
const label = (r: string): string => agents.get(r)?.label ?? r
const say = (t: string): Message => ({ role: 'user', content: [{ type: 'text', text: t }] })
const history = (role: string): Message[] => [
  say('Hello'),
  { role: 'assistant', content: [{ type: 'text', text: "Hello! I'm Sachivji, your AI assistant." }] },
  say('Hello'),
  { role: 'assistant', content: [{ type: 'text', text: 'Hello again! Since I am currently acting as the **Planning Specialist**, I help you plan.', agentRole: 'planning' }] },
  say('Hello'),
  { role: 'assistant', content: [{ type: 'text', text: "Hello! I'm ready to assist you as your **History Analyst**.", agentRole: 'history-analyst' }] },
  say('Hello')
].filter(() => role !== '')

let wrong = 0
for (const role of roles) {
  const orchestrator = new Orchestrator(new OllamaProvider(), model, agents, SYSTEM_PROMPT, registry.list(), (async () => ({ approved: false })) as never, { workspaceGuard: { root: process.cwd() }, currentSessionId: 'probe' } as never, new AbortController().signal, { planningEnabled: false })
  let text = ''
  for await (const e of orchestrator.run(history(role), role as never)) {
    if (e.kind === 'stream' && e.event.type === 'text_delta') text += e.event.text
  }
  // A reply "claims" a role when it says it is / acts as / is the one named: "I'm ... Planner", "as the Planning Specialist", "your History Analyst".
  const claims = (r: string): boolean => new RegExp(`(?:\\b(?:I'm|I am|as|as your|as the|your|acting as)\\b[^.\\n]{0,40}${label(r).split(' ')[0]})`, 'i').test(text)
  const named = roles.filter((r) => r !== role && claims(r))
  const own = claims(role)
  const bad = named.length > 0 && !own
  if (bad) wrong++
  console.log(`${bad ? 'WRONG' : text.trim() ? 'ok   ' : 'EMPTY'} ${label(role).padEnd(22)} claims others: [${named.map(label).join(', ')}] own:${own} | ${text.slice(0, 130).replace(/\n/g, ' ')}`)
}
// Auto: the history holds pinned replies by Planner and History Analyst; the router must still answer as Sachivji.
{
  const orchestrator = new Orchestrator(new OllamaProvider(), model, agents, SYSTEM_PROMPT, registry.list(), (async () => ({ approved: false })) as never, { workspaceGuard: { root: process.cwd() }, currentSessionId: 'probe' } as never, new AbortController().signal, { planningEnabled: false })
  let text = ''
  for await (const e of orchestrator.run(history('x'), null)) if (e.kind === 'stream' && e.event.type === 'text_delta') text += e.event.text
  console.log(`AUTO ${text.slice(0, 160).replace(/\n/g, ' ')}`)
}
console.log(`\n${wrong} of ${roles.length} roles answered as another specialist`)
process.exit(0)
