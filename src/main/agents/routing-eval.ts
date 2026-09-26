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
  | { type: 'answer' }
  | { type: 'error'; message: string }

export interface RoutingOutcome {
  case: RoutingCase
  choice: Choice
  correct: boolean
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

async function firstChoice(provider: ModelProvider, model: string, setup: EvalSetup, prompt: string, signal?: AbortSignal): Promise<Choice> {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  try {
    let answered = false
    for await (const ev of provider.stream({ model, system: setup.system, messages, tools: setup.tools, maxTokens: 1024, signal })) {
      if (ev.type === 'tool_use_start') {
        const role = roleFromDelegateName(ev.name)
        return role ? { type: 'delegate', role } : { type: 'tool', name: ev.name }
      }
      if (ev.type === 'text_delta') answered = true
    }
    return answered ? { type: 'answer' } : { type: 'error', message: 'no output' }
  } catch (err) {
    return { type: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

export interface RoutingReport {
  provider: string
  model: string
  outcomes: RoutingOutcome[]
  correct: number
  total: number
  /** Per expected role: [correct, total]. */
  byRole: Record<string, [number, number]>
}

export async function runRoutingEval(
  provider: ModelProvider,
  model: string,
  setup: EvalSetup,
  cases = buildRoutingCases(),
  signal?: AbortSignal,
  /** Called as each case finishes — a real model can take a minute per case, so a run must show progress and survive being cut short. */
  onOutcome?: (outcome: RoutingOutcome, index: number, total: number) => void
): Promise<RoutingReport> {
  const outcomes: RoutingOutcome[] = []
  for (const [i, c] of cases.entries()) {
    const choice = await firstChoice(provider, model, setup, c.prompt, signal)
    const outcome: RoutingOutcome = { case: c, choice, correct: isCorrect(choice, c.expectedRole, setup.toolOwner) }
    outcomes.push(outcome)
    onOutcome?.(outcome, i, cases.length)
  }
  const byRole: Record<string, [number, number]> = {}
  for (const o of outcomes) {
    const e = (byRole[o.case.expectedRole] ??= [0, 0])
    e[1]++
    if (o.correct) e[0]++
  }
  return { provider: provider.id, model, outcomes, correct: outcomes.filter((o) => o.correct).length, total: outcomes.length, byRole }
}

export function describeChoice(c: Choice): string {
  return c.type === 'delegate' ? `delegate ${c.role}` : c.type === 'tool' ? `tool ${c.name}` : c.type === 'error' ? `error: ${c.message}` : 'answered directly'
}

export function formatRoutingReport(r: RoutingReport): string {
  const lines = [`Routing evaluation — ${r.provider} / ${r.model}: ${r.correct}/${r.total} correct`]
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

