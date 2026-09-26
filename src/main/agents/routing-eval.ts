import { ROLE_MANIFEST } from '@shared/agents'
import type { Message, ModelProvider, ToolDefinition } from '../providers/types'

/**
 * Routing evaluation for the slim router (design-discussion.md risk gate 2, open question 7).
 *
 * A lint cannot prove routing quality — only a model can. This replays each role's
 * `examples` (which should go to that role) and `notExamples` (which look like they do
 * but belong to another role — the bracket at the end of each names it) against a real
 * provider, with the router's real system prompt and tool list, and records what the model
 * does with the FIRST round: which delegate tool it calls, which core tool it calls directly,
 * or whether it just answers. No tool is executed.
 *
 * Non-deterministic by nature: run it per provider/model, more than once. It is a
 * measurement to look at, not a pass/fail gate with a magic threshold.
 */

export interface RoutingCase {
  /** The user prompt, without the trailing `[role]` marker. */
  prompt: string
  /** The role id that should take it. */
  expectedRole: string
  kind: 'example' | 'notExample'
  /** The role whose manifest entry the case came from. */
  from: string
}

/** Cases from the manifest. Only roles the router routes to (pickable or plannable) are evaluated. */
export function buildRoutingCases(manifest: typeof ROLE_MANIFEST = ROLE_MANIFEST): RoutingCase[] {
  const cases: RoutingCase[] = []
  for (const r of manifest) {
    if (!r.pickable && !r.plannable) continue
    for (const prompt of r.examples) cases.push({ prompt, expectedRole: r.id, kind: 'example', from: r.id })
    for (const raw of r.notExamples) {
      const m = /\s*\[([^\]]+)\]\s*$/.exec(raw)
      if (!m) continue
      const first = m[1].split(/,| then /).map((x) => x.trim().split(' ')[0]).find(Boolean)
      // "[orchestrator ...]" (the top level builds decks) is not a role the router delegates to.
      if (!first || first === 'orchestrator') continue
      cases.push({ prompt: raw.slice(0, m.index).trim(), expectedRole: first, kind: 'notExample', from: r.id })
    }
  }
  return cases
}

export type Choice =
  | { type: 'delegate'; role: string }
  | { type: 'tool'; name: string }
  /** `excerpt`: the start of what the model said instead of delegating — so a clarifying question can be told from pasted code. */
  | { type: 'answer'; excerpt?: string }
  | { type: 'error'; message: string }

export interface RoutingOutcome {
  case: RoutingCase
  choice: Choice
  correct: boolean
  /** Rounds the model took to reach its decisive choice (1 = decided at once). */
  rounds: number
  /** Names of exploration tools it called first. */
  explored: string[]
}

const DELEGATE_PREFIX = 'delegate_to_'

/** `delegate_to_data_access`-style names back to role ids. */
export function roleFromDelegateName(name: string): string | undefined {
  if (!name.startsWith(DELEGATE_PREFIX)) return undefined
  const slug = name.slice(DELEGATE_PREFIX.length).replace(/_/g, '-')
  return ROLE_MANIFEST.some((r) => r.id === slug) ? slug : undefined
}

export interface EvalSetup {
  system: string
  tools: ToolDefinition[]
  /**
   * Read-only exploration tools the evaluation ANSWERS instead of scoring, so a model that looks around first ("what is in this folder?",
   * "what can I do?") is judged on where it goes next. Maps a tool name to the result to hand back. Absent = one round only (the old
   * behaviour: whatever the model calls first is its choice).
   */
  infoTools?: Record<string, (input: Record<string, unknown>) => string>
  /** tool name -> role that owns it, so a router that handles a request with its own core tool can be judged fairly. */
  toolOwner: (toolName: string) => string | undefined
}

/**
 * Correct when the model delegates to the expected role, or handles the request itself with a tool
 * the expected role owns (a router that runs `shell_execute` for "run analysis.py" did the right
 * thing). A plain answer counts as correct only for the Planner (reasoning-only).
 */
export function isCorrect(choice: Choice, expectedRole: string, toolOwner: EvalSetup['toolOwner']): boolean {
  if (choice.type === 'delegate') return choice.role === expectedRole
  if (choice.type === 'tool') return toolOwner(choice.name) === expectedRole
  if (choice.type === 'answer') return expectedRole === 'planning'
  return false
}

async function decide(
  provider: ModelProvider,
  model: string,
  setup: EvalSetup,
  prompt: string,
  maxRounds: number,
  signal?: AbortSignal
): Promise<{ choice: Choice; rounds: number; explored: string[] }> {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  const explored: string[] = []
  const info = setup.infoTools ?? {}
  for (let round = 1; round <= maxRounds; round++) {
    const calls = new Map<string, { name: string; json: string; thoughtSignature?: string }>()
    let answered = false
    let text = ''
    try {
      for await (const ev of provider.stream({ model, system: setup.system, messages, tools: setup.tools, maxTokens: 1024, signal })) {
        if (ev.type === 'tool_use_start') calls.set(ev.id, { name: ev.name, json: '', thoughtSignature: ev.thoughtSignature })
        else if (ev.type === 'tool_use_delta') {
          const c = calls.get(ev.id)
          if (c) c.json += ev.partialInput
        } else if (ev.type === 'text_delta') {
          answered = true
          text += ev.text
        }
      }
    } catch (err) {
      return { choice: { type: 'error', message: err instanceof Error ? err.message : String(err) }, rounds: round, explored }
    }
    if (calls.size === 0) return { choice: answered ? { type: 'answer', excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 140) } : { type: 'error', message: 'no output' }, rounds: round, explored }

    // The first call that is NOT an exploration tool is the decisive choice.
    const entries = [...calls.entries()]
    const decisive = entries.find(([, c]) => !(c.name in info) || round === maxRounds)
    if (decisive) {
      const name = decisive[1].name
      const role = roleFromDelegateName(name)
      return { choice: role ? { type: 'delegate', role } : { type: 'tool', name }, rounds: round, explored }
    }
    // Every call was exploration: answer them and let the model continue.
    const parse = (json: string): Record<string, unknown> => {
      try {
        return JSON.parse(json || '{}') as Record<string, unknown>
      } catch {
        return {}
      }
    }
    messages.push({
      role: 'assistant',
      content: [...(text ? [{ type: 'text' as const, text }] : []), ...entries.map(([id, c]) => ({ type: 'tool_use' as const, id, name: c.name, input: parse(c.json), ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}) }))]
    })
    messages.push({
      role: 'user',
      content: entries.map(([id, c]) => ({ type: 'tool_result' as const, toolUseId: id, content: info[c.name](parse(c.json)) }))
    })
    for (const [, c] of entries) explored.push(c.name)
  }
  return { choice: { type: 'error', message: 'no decision' }, rounds: maxRounds, explored }
}

export interface RoutingReport {
  provider: string
  model: string
  outcomes: RoutingOutcome[]
  correct: number
  total: number
  /** Per expected role: [correct, total]. */
  byRole: Record<string, [number, number]>
  /** Cases where the model explored (listed a folder, asked what it can do) before deciding — extra rounds and tokens even when it ends up right. */
  exploredFirst: number
}

export async function runRoutingEval(
  provider: ModelProvider,
  model: string,
  setup: EvalSetup,
  cases = buildRoutingCases(),
  signal?: AbortSignal,
  maxRounds = 1,
  /** Called as each case finishes — a real model can take a minute per case, so a run must show progress and survive being cut short. */
  onOutcome?: (outcome: RoutingOutcome, index: number, total: number) => void
): Promise<RoutingReport> {
  const outcomes: RoutingOutcome[] = []
  for (const [i, c] of cases.entries()) {
    const { choice, rounds, explored } = await decide(provider, model, setup, c.prompt, maxRounds, signal)
    const outcome: RoutingOutcome = { case: c, choice, correct: isCorrect(choice, c.expectedRole, setup.toolOwner), rounds, explored }
    outcomes.push(outcome)
    onOutcome?.(outcome, i, cases.length)
  }
  const byRole: Record<string, [number, number]> = {}
  for (const o of outcomes) {
    const e = (byRole[o.case.expectedRole] ??= [0, 0])
    e[1]++
    if (o.correct) e[0]++
  }
  return { provider: provider.id, model, outcomes, correct: outcomes.filter((o) => o.correct).length, total: outcomes.length, byRole, exploredFirst: outcomes.filter((o) => o.explored.length > 0).length }
}

export function describeChoice(c: Choice): string {
  return c.type === 'delegate' ? `delegate ${c.role}` : c.type === 'tool' ? `tool ${c.name}` : c.type === 'error' ? `error: ${c.message.replace(/\s+/g, ' ').slice(0, 140)}` : c.excerpt ? `answered directly: "${c.excerpt}"` : 'answered directly'
}

export function formatRoutingReport(r: RoutingReport): string {
  const lines = [`Routing evaluation — ${r.provider} / ${r.model}: ${r.correct}/${r.total} correct` + (r.exploredFirst ? ` (${r.exploredFirst} explored first — extra rounds)` : '')]
  for (const [role, [ok, n]] of Object.entries(r.byRole)) lines.push(`  ${role.padEnd(18)} ${ok}/${n}`)
  const misses = r.outcomes.filter((o) => !o.correct)
  if (misses.length) {
    lines.push('Misses:')
    for (const m of misses) {
      const got = describeChoice(m.choice)
      lines.push(`  [${m.case.kind}] "${m.case.prompt}" → expected ${m.case.expectedRole}, got ${got}`)
    }
  }
  return lines.join('\n')
}

// --- Replay probe (risk gate 1) ----------------------------------------------------

export interface ReplayProbeResult {
  variant: 'raw' | 'collapsed'
  accepted: boolean
  error?: string
}

/**
 * Asks a provider to continue a conversation whose history contains a completed call to a tool that is
 * NOT in the request's tool list — once as-is ("raw"), once with the call replayed as text
 * ("collapsed", what the slim router actually sends). Tells you whether this provider rejects the raw
 * form; the collapsed form must always be accepted.
 */
export async function runReplayProbe(
  provider: ModelProvider,
  model: string,
  rawHistory: Message[],
  collapsedHistory: Message[],
  tools: ToolDefinition[],
  signal?: AbortSignal
): Promise<ReplayProbeResult[]> {
  const results: ReplayProbeResult[] = []
  for (const [variant, history] of [['raw', rawHistory], ['collapsed', collapsedHistory]] as const) {
    try {
      let sawAny = false
      for await (const ev of provider.stream({ model, system: 'You are a helpful assistant. Reply briefly.', messages: history, tools, maxTokens: 64, signal })) {
        if (ev.type === 'text_delta' || ev.type === 'tool_use_start' || ev.type === 'message_stop') sawAny = true
      }
      results.push({ variant, accepted: sawAny })
    } catch (err) {
      results.push({ variant, accepted: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return results
}

/** The two histories the probe compares. `collapseUnavailableToolCalls` (context/prepare-context.ts) produces the second from the first. */
export function replayProbeHistory(): Message[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'Write the numbers 1 to 3 into a spreadsheet.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'probe_1', name: 'xlsx_write', input: { path: 'numbers.xlsx', rows: [[1], [2], [3]] } }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'probe_1', content: 'Wrote 3 rows to numbers.xlsx.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done — numbers.xlsx has the three rows.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Thanks. Now say hello.' }] }
  ]
}

