import { randomUUID } from 'node:crypto'
import type { ContentBlock, Message, StreamEvent } from '@shared/protocol'
import type { AgentRole } from '@shared/agents'
import { PLANNABLE_ROLES, roleLabel, type RoleMeta } from '@shared/agents'
import { contextWindowFor, maxOutputTokensFor } from '@shared/model-metadata'
import { evaluateClassifyGate, shouldSampleForCalibration, type ClassifyGateVerdict } from './classify-gate'
import {
  CONTEXT_BUDGET_FRACTION,
  LISTING_TOOL_NAMES,
  normalizeUserNotesForWire,
  overheadTokens,
  resolveContextWindow,
  splitIntoTurns
} from '../context/prepare-context'
import { isRateLimitError, retryAfterMsFromError } from '../providers/rate-limit'
import type { ModelProvider, ToolDefinition } from '../providers/types'
import { SHOW_MEDIA_MARKER, type ShowMediaPayload } from '../tools/show-media'
import type { Tool, ToolContext } from '../tools/types'
import { buildRoleDigest, isRoleAvailable, type ConfigurationCounts } from './capabilities'
import {
  diffSnapshots,
  formatDelegateResult,
  formatInputs,
  isCapturableDataTool,
  MAX_DATA_FILES_PER_DELEGATE,
  parseHandoffTag,
  pruneHandoffDirs,
  saveHandoffData,
  snapshotWorkspace,
  type DelegateResult,
  type HandoffDataFile,
  type HandoffItem
} from './handoff'

export interface Agent {
  role: AgentRole
  /**
   * Set only on user-defined roles (design section 11); built-ins take their label and flags from the manifest. `label` is what chips and
   * the picker show, `pickable` / `plannable` are the manifest flags, `meta` carries the description and examples for listings, and
   * `custom` marks the role as user-defined (so, for instance, the slim router never treats it as the owner of a tool).
   */
  custom?: boolean
  label?: string
  pickable?: boolean
  plannable?: boolean
  meta?: RoleMeta
  /** One-line description used in the orchestrator's own system prompt to describe when to delegate here. */
  summary: string
  systemPrompt: string
  tools: Tool[]
  /**
   * Opt-in, per #77 — every existing role leaves this unset. A `true` here
   * changes only `dispatchDelegate`'s conversation scoping: the nested call
   * gets just its own task/brief as context instead of the entire parent
   * conversation, for a bounded, self-contained, repeatedly-invoked-per-turn
   * role (e.g. a "compose one slide" specialist) that doesn't need — and
   * ideally shouldn't see — everything said so far. Every delegate call,
   * isolated or not, already gets its own fresh round budget (see
   * `maxRounds`); token usage still always rolls up into the parent's
   * cumulative totals, so cost accounting stays honest and complete either
   * way.
   */
  isolated?: boolean
  /** The fresh round budget this role's own delegate calls get — every delegate call has always had its own pool, isolated or not (found live: a single turn-wide shared pool let one delegate's legitimate multi-step work starve the rest of the turn). Defaults to `MAX_TOTAL_ROUNDS` if omitted. */
  maxRounds?: number
}

export interface ConfirmDecision {
  approved: boolean
  input?: Record<string, unknown>
}

export interface ToolConfirmRequest {
  toolUseId: string
  name: string
  input: Record<string, unknown>
  description: string
  secretFields?: string[]
  hasValidation?: boolean
}

/**
 * Asked whenever a turn/delegate call's round or time budget runs out —
 * found live: the existing wrap-up-and-summarize behavior (see runLoop's
 * exhaustion handling) is the right *default* recovery, but for a turn that
 * was making genuine, still-succeeding progress (a real multi-step Docker
 * build/debug cycle, not a runaway loop), silently finalizing a summary
 * instead of actually finishing the work isn't always what the user wants.
 * `requestId` is fresh every time — the same turn/delegate call can hit this
 * more than once if granted more budget and then exhausts that too.
 */
export interface LimitReachedRequest {
  requestId: string
  reason: 'rounds' | 'time'
  roundsUsed: number
  maxRounds: number
  /** The specialist whose own delegate call hit the limit — undefined for the top-level turn itself. */
  agentRole?: AgentRole
}

export interface LimitDecision {
  /** True grants a fresh round budget (and, if the reason was 'time', a fresh wall-clock deadline) and resumes; false proceeds to the existing wrap-up-and-summarize behavior. */
  continueWorking: boolean
}

/**
 * What `Orchestrator.run` yields. Kept decoupled from Electron/the DB (no
 * `WebContents`, no direct `insertMessage` calls) so it stays unit-testable
 * against a mocked provider later (TASKS.md #59) — the caller in
 * ipc/register.ts does the actual IPC emit / DB persistence based on this.
 */
export type OrchestratorEvent =
  | { kind: 'stream'; event: StreamEvent }
  | { kind: 'message'; role: 'assistant' | 'user'; content: ContentBlock[] }

/**
 * The round ceiling each call to `runLoop` gets on its own — the top-level
 * turn, and (since every delegate call now gets its own fresh pool rather
 * than sharing one turn-wide budget — see `dispatchDelegate`) each
 * individual delegate call too. Deliberately generous now that it's scoped
 * per-call rather than shared: was 12 and shared turn-wide, which a real,
 * completely legitimate session (clone a repo, read 4 files, delegate a
 * multi-step Docker build/debug/fix cycle — nothing looping or wasted) hit
 * mid-task, with the container not yet confirmed working. `TURN_DEADLINE_MS`
 * remains the real backstop against a turn actually running too long; this
 * exists mainly to catch genuine runaway loops, not to ration ordinary work.
 */
const MAX_TOTAL_ROUNDS = 20
const DELEGATE_PREFIX = 'delegate_to_'

/**
 * How long a single provider round is allowed to run before being treated
 * as hung and stopped the same way a user-clicked Stop already is. Found
 * live: a real turn (a rich multi-slide presentation) sat completely
 * unresponsive for over an hour with zero visible error and Stop unable to
 * help — confirmed directly against the running process that nothing was
 * actually pending (no open network connection, no pending Promise
 * anywhere in the heap), meaning the round had already died silently with
 * no bound on how long the app would just sit there before anyone noticed.
 * 5 minutes is generous for a legitimately slow local model composing
 * something complex (seen live taking several minutes for one real round)
 * but not infinite — every round now has a hard ceiling.
 *
 * This is the ceiling for a round's *first* attempt only — see
 * `startRoundTimer`'s adaptive budget, which grows on each consecutive
 * retry. A flat 5-minute ceiling applied identically to every retry was
 * itself found live to be a second bug on top of the original hang: on
 * timeout, the retry resends the exact same prompt/context with no
 * adaptation, so a round that genuinely needs close to or over 5 minutes
 * can never converge — every attempt gets killed just before finishing and
 * restarts from zero, burning the whole turn deadline on repeated wasted
 * restarts while surfacing a warning that looks like a failure each time.
 */
const ROUND_TIMEOUT_MS = 5 * 60 * 1000

/** Never budget a round less than this, even one started with almost no turn time left (e.g. the final wrap-up call). */
const ROUND_TIMEOUT_FLOOR_MS = 30 * 1000

/** Always reserve at least this much of the remaining turn budget when sizing a round's timeout, so ending a round never leaves literally zero time for the next attempt or the final wrap-up call. */
const ROUND_TIMEOUT_SAFETY_MARGIN_MS = 60 * 1000

/**
 * A hard wall-clock ceiling on one whole turn, top-level rounds and every
 * delegate call combined — not just a per-round bound. Found live: a
 * single request (a rich presentation) ran past an hour with no end in
 * sight even before it silently died; a fixed per-round timeout alone
 * still lets a turn with many legitimately-slow rounds run indefinitely
 * long in aggregate. Checked at the top of every `runLoop` iteration
 * (top-level and every delegate, isolated or not — they all share the
 * same `state.deadlineAt`, see `RunState`); once past it, `runLoop` stops
 * starting new rounds the exact same way running out of `maxRounds`
 * already does, falling into the existing round-cap wrap-up path so
 * whatever's real gets synthesized into an actual answer instead of
 * silently cut off.
 */
const TURN_DEADLINE_MS = 15 * 60 * 1000

/**
 * A ceiling on one `tool.execute()` call. Found live: the round-timeout
 * above only wraps `provider.stream()` — once a round ends in a tool call,
 * `dispatchTool`'s `await tool.execute(...)` has no timeout and isn't tied
 * to `this.signal` (Stop) at all, so a tool that never resolves (a stalled
 * write, a hung network call inside a tool with no timeout of its own)
 * reproduces the exact "sat unresponsive for over an hour, Stop unable to
 * cancel it" bug the round-timeout was built to fix, just one step later in
 * the same loop. This can't force-cancel whatever the tool is actually
 * doing (`Tool.execute` takes no signal) — same limitation the round timer
 * itself accepts for a stalled provider connection — but it guarantees the
 * orchestrator's own wait, and so the whole turn, is never blocked forever.
 */
const TOOL_EXECUTE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * TASKS.md #91 — how many app-level rate-limit retries a single round gets
 * (separate from, and on top of, each SDK's own internal ~2-retry backoff —
 * see `rate-limit.ts`). Bounded so a genuinely persistent rate limit still
 * ends the turn with a clear message eventually, rather than retrying
 * forever.
 */
const MAX_RATE_LIMIT_RETRIES = 5

/** A hard ceiling on any single rate-limit wait, even if the provider's own `Retry-After` asks for longer — keeps one retry from single-handedly consuming most of the turn's wall-clock budget. */
const RATE_LIMIT_MAX_WAIT_MS = 2 * 60 * 1000

/** Exponential backoff for when the provider gave no `Retry-After` (or `retry-after-ms`) at all — e.g. every Google/`@google/genai` error, which carries no headers (see `rate-limit.ts`). Starts at 2s, doubles each retry, capped by `RATE_LIMIT_MAX_WAIT_MS` at the call site. */
function rateLimitBackoffMs(attempt: number): number {
  return 2000 * 2 ** (attempt - 1)
}

/**
 * Resolves once `ms` elapses or `signal` aborts, whichever comes first —
 * used for a rate-limit wait, which (unlike a round's own timeout) has no
 * provider request in flight to race against, just a deliberate pause.
 * Returns the real elapsed time so the caller can extend `state.deadlineAt`
 * by exactly what was actually waited, not the originally intended amount,
 * on the rare case a Stop click cuts the wait short.
 */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<number> {
  const start = Date.now()
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(0)
      return
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      resolve(Date.now() - start)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve(Date.now() - start)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** See `capRepeatedToolResults` below. */
const MAX_KEPT_RESULTS_PER_TOOL = 3

/**
 * TASKS.md #149: the argument names that identify a genuinely distinct RESOURCE for a given tool, so
 * different targets don't compete for the same recency-cap bucket — root-caused live (session `cd81e5f5`):
 * 15 `list_directory` calls across ~5 different real paths all shared one name-only bucket, evicting each
 * other's results regardless of which path they were actually about. Deliberately scoped to just the two
 * tools that incident actually involved (`list_directory`/`find_files`, #148) — NOT `read_file`, which the
 * existing test suite already uses in two places as a generic stand-in for a fuzzy-repeated-call tool like
 * `web_search` (cheaper to script than a real web_search mock); resource-keying it too would silently change
 * that established, deliberate test behavior without being asked to. A tool with no entry here keeps the
 * original name-only bucketing — for a fuzzy free-text-query tool (`web_search`), many distinct-but-similar
 * calls SHOULD still compete for the same cap as a backstop, even when `collapseDuplicateToolResults`'s
 * URL-overlap detection above didn't catch them as near-duplicates; keying by exact query text would defeat
 * that entirely (every reworded query would get its own never-full bucket).
 */
const RESOURCE_KEY_ARGS: Readonly<Record<string, readonly string[]>> = {
  list_directory: ['path'],
  find_files: ['path', 'pattern']
}

function bucketKey(toolName: string, input: Record<string, unknown>): string {
  const argNames = RESOURCE_KEY_ARGS[toolName]
  if (!argNames) return toolName
  return `${toolName}:${argNames.map((a) => JSON.stringify(input[a] ?? null)).join(',')}`
}

/**
 * TASKS.md #149: an older `list_directory`/`find_files` result gets collapsed to a compact-but-complete
 * form — every entry it found, just without the per-line "dir "/"file " decoration or find_files' header
 * line — rather than erased. This is the fix for the incident's actual failure: a collapsed listing used to
 * lose the filenames it found entirely, which is why the model both re-issued identical calls (it could no
 * longer tell whether an earlier call had found anything) and stated an unlisted filename as fact (pattern-
 * completing off adjacent real context once the real one was gone). #148's own hard requirement: a "do
 * something for each file" task must still be able to see every entry from a collapsed result. Returns
 * `undefined` when there's nothing meaningful to compact (an empty directory / no matches) — that result is
 * already minimal, so the caller leaves it completely untouched rather than wrapping a placeholder around
 * essentially nothing.
 */
function compactListing(toolName: string, content: string): string | undefined {
  const lines = content.split('\n')
  const names =
    toolName === 'list_directory'
      ? lines.map((l) => l.replace(/^(dir|file)\s+/, '')).filter((l) => l && l !== '(empty directory)')
      : lines.slice(1).filter(Boolean) // find_files: line 0 is always the header ("N matched"/"No files matched")
  if (names.length === 0) return undefined
  return `[Earlier ${toolName} result, collapsed to save context but still complete — every entry found: ${names.join(', ')}]`
}

/**
 * Repeated calls to the same read-only tool within a single turn — a
 * research agent refining a `web_search` query several times being the
 * concrete case this was built for — each stayed fully expanded in
 * `conversation` for every later round, since nothing else trims *within*
 * a turn: `prepareConversation` (ipc/register.ts) only runs once, before
 * the turn starts, against prior history, and `trimToolResults` only caps
 * a single oversized result, not the sum of many modest ones. Found live:
 * a real complex request made 9 separate `web_search` calls in one turn,
 * most refinements of a query that hadn't found what was needed yet, and
 * every one of those stayed in full for every subsequent round.
 *
 * Keeps only the most recent `MAX_KEPT_RESULTS_PER_TOOL` results per
 * `bucketKey` (tool name, or tool name + the resource it targeted for a
 * path-shaped tool — see `RESOURCE_KEY_ARGS`) in what's actually sent to
 * the provider; older ones collapse to a compact-but-complete marker for a
 * listing tool (`compactListing`) or a plain one-line marker otherwise (the
 * original tool_use input block is untouched either way and still cheap,
 * so the model can always see *what* it already tried). Only applies to a
 * tool whose `mutates` is statically `false` — a completed write/mutating
 * call represents a real side effect worth remembering in full for as long
 * as it's in context; a stale read is safely re-fetchable if actually
 * still needed. **Genuinely scoped to the current turn** (`splitIntoTurns`,
 * the one canonical turn-boundary definition in this codebase) — a call
 * from an earlier turn is never counted or touched here, matching what
 * this function's own doc comment always claimed but, before #149, never
 * actually enforced (it ran against the whole session array). Never
 * mutates `conversation` itself (returns a fresh array only when there's
 * something to collapse) — this only ever affects what's sent to the
 * provider on this and later rounds, never what's persisted to SQLite or
 * shown in the live/reloaded UI transcript, same as every other trimming
 * pass in this codebase.
 */
function capRepeatedToolResults(conversation: Message[], toolByName: ReadonlyMap<string, Tool>): Message[] {
  const turns = splitIntoTurns(conversation)
  const currentTurn = turns[turns.length - 1] ?? []
  const currentTurnUseIds = new Set<string>()
  for (const m of currentTurn) {
    for (const b of m.content) {
      if (b.type === 'tool_use') currentTurnUseIds.add(b.id)
    }
  }

  const toolNameById = new Map<string, string>()
  const idsByBucket = new Map<string, string[]>()
  for (const m of conversation) {
    for (const b of m.content) {
      if (b.type !== 'tool_use' || !currentTurnUseIds.has(b.id)) continue
      const tool = toolByName.get(b.name)
      if (!tool || tool.mutates !== false) continue
      toolNameById.set(b.id, b.name)
      const key = bucketKey(b.name, b.input)
      const ids = idsByBucket.get(key) ?? []
      ids.push(b.id)
      idsByBucket.set(key, ids)
    }
  }
  const staleIds = new Set<string>()
  for (const ids of idsByBucket.values()) {
    if (ids.length <= MAX_KEPT_RESULTS_PER_TOOL) continue
    for (const id of ids.slice(0, ids.length - MAX_KEPT_RESULTS_PER_TOOL)) staleIds.add(id)
  }
  if (staleIds.size === 0) return conversation

  return conversation.map((m) => ({
    ...m,
    content: m.content.map((b): ContentBlock => {
      if (b.type !== 'tool_result' || !staleIds.has(b.toolUseId)) return b
      const toolName = toolNameById.get(b.toolUseId)
      const compact = toolName && LISTING_TOOL_NAMES.has(toolName) ? compactListing(toolName, b.content) : undefined
      if (compact !== undefined) return { ...b, content: compact }
      if (toolName && LISTING_TOOL_NAMES.has(toolName)) return b // nothing to compact (empty/no-match) — already minimal, leave untouched
      return {
        ...b,
        content: '[Earlier result omitted to save context — this tool was called again later in the same turn. See the tool_use input above for what was tried.]'
      }
    })
  }))
}

const DUPLICATE_URL_OVERLAP_THRESHOLD = 0.7

/** Every http(s) URL literally present in a string — deliberately generic (not web_search-specific) so it also catches e.g. parse_html's link listing. */
function extractUrls(text: string): Set<string> {
  return new Set(text.match(/https?:\/\/\S+/g) ?? [])
}

/**
 * Collapses a read-only tool's result when it returns (almost) the same
 * URLs an earlier call to the *same* tool already returned earlier in this
 * turn — found live: chasing a document that wasn't findable, a research
 * agent kept rewording its `web_search` query, and each reworded attempt
 * surfaced the same handful of articles again, ballooning context with
 * duplicate coverage instead of new information (confirmed against a real
 * session: 9 near-identical queries for a "Disha Salian FIR pdf" that
 * doesn't exist as a directly-searchable document, all returning mostly
 * the same sources). Detected by literal URL overlap, not semantic
 * similarity, so a genuinely different result — even for a
 * superficially-similar-looking query — is left untouched. A tool's first
 * appearance in the turn is never collapsed (nothing to compare against
 * yet); only overlap with *prior* calls of the same tool counts. Runs
 * before, and independently of, `capRepeatedToolResults`' pure recency cap
 * below — that one still applies afterward as a hard backstop even when no
 * duplicate is detected here (e.g. many genuinely distinct searches).
 */
function collapseDuplicateToolResults(conversation: Message[], toolByName: ReadonlyMap<string, Tool>): Message[] {
  const toolNameByUseId = new Map<string, string>()
  for (const m of conversation) {
    for (const b of m.content) {
      if (b.type !== 'tool_use') continue
      const tool = toolByName.get(b.name)
      if (tool && tool.mutates === false) toolNameByUseId.set(b.id, b.name)
    }
  }

  const seenUrlsByTool = new Map<string, Set<string>>()
  const duplicateIds = new Set<string>()
  for (const m of conversation) {
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue
      const toolName = toolNameByUseId.get(b.toolUseId)
      if (!toolName) continue
      const urls = extractUrls(b.content)
      if (urls.size === 0) continue
      const seen = seenUrlsByTool.get(toolName)
      if (seen) {
        const overlap = [...urls].filter((u) => seen.has(u)).length / urls.size
        if (overlap >= DUPLICATE_URL_OVERLAP_THRESHOLD) duplicateIds.add(b.toolUseId)
      }
      const union = seen ?? new Set<string>()
      for (const u of urls) union.add(u)
      seenUrlsByTool.set(toolName, union)
    }
  }
  if (duplicateIds.size === 0) return conversation

  return conversation.map((m) => ({
    ...m,
    content: m.content.map((b): ContentBlock => {
      if (b.type !== 'tool_result' || !duplicateIds.has(b.toolUseId)) return b
      return {
        ...b,
        content:
          '[Result omitted — its sources substantially overlap an earlier search this turn. Rewording the query again is unlikely to surface anything new; try a different approach, or tell the user this could not be found.]'
      }
    })
  }))
}

/** Shared by `runLoop` (what's actually sent to the provider) and `resolveMaxOutputTokens` (what overhead to budget for). */
function toToolDefs(tools: Tool[]): ToolDefinition[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
}

/** The latest message's own plain text, for the classify-gate heuristic (classify-gate.ts) — ignores tool_use/tool_result/warning blocks, same as a user's actual typed request would read. */
function latestMessageText(conversation: Message[]): string {
  const latest = conversation[conversation.length - 1]
  if (!latest) return ''
  return latest.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

/**
 * design-discussion.md §13.5, TASKS #144: a deliberately narrow, conservative check for the user having
 * restricted where information may come from ("only use the wiki for this", "don't search the internet") —
 * if a `no_information` step's fallback (executePlan below) fired anyway, that would be its own kind of
 * unrequested action (Appendix D1's "no unrequested side effect" principle applied to sourcing, not
 * mutation). Unlike `evaluateClassifyGate` (#95), which is conservative toward running the real check
 * because a false "skip" there silently loses real work, this is conservative toward the OPPOSITE
 * direction: a false negative here (missing a real restriction) lets an unwanted web fallback through,
 * which is the worse mistake, so it only fires on an unambiguous phrase and defaults to "not restricted"
 * — i.e. fallback allowed — whenever it isn't sure. Not a general intent classifier; a cheap, narrow,
 * easily-extended signal, in the same spirit as the compound-request connector-word check it sits beside.
 */
const SOURCE_RESTRICTION_SIGNAL =
  /\bonly\b(?:\s+\S+){0,4}\s+(?:the\s+)?(?:wiki|knowledge base)\b|\b(?:don't|do not|never)\b(?:\s+\S+){0,4}\s+(?:the\s+)?(?:web|internet|online)\b|\bwithout\b(?:\s+\S+){0,3}\s+(?:the\s+)?(?:web|internet)\b|\bno\s+(?:web|internet)\s+search\b/i

export function detectsSourceRestriction(latestMessageText: string): boolean {
  return SOURCE_RESTRICTION_SIGNAL.test(latestMessageText)
}

/**
 * A cheap, local, provider-independent stand-in for a real `countTokens`
 * call — deliberately conservative (an undercount of real tokens-per-char
 * only ever makes this *more* likely to trigger the real check below, never
 * less) so `refitConversationToBudget` can skip the real check entirely on
 * the overwhelming majority of ordinary rounds, where the conversation is
 * nowhere near the budget. Never used as the actual trim decision once the
 * real check has run — only to gate whether that real check (a genuine
 * network call for Anthropic/Google) happens at all, and to decide how many
 * results to collapse without re-calling the provider after each one.
 */
const ROUGH_CHARS_PER_TOKEN = 3

function roughTokenEstimate(conversation: Message[]): number {
  let chars = 0
  for (const m of conversation) {
    for (const b of m.content) {
      if (b.type === 'text') chars += b.text.length
      else if (b.type === 'tool_result') chars += b.content.length
      else if (b.type === 'tool_use') chars += b.name.length + JSON.stringify(b.input).length
    }
  }
  return Math.ceil(chars / ROUGH_CHARS_PER_TOKEN)
}

const CONTEXT_FIT_OMITTED_MARKER =
  "[Earlier tool result omitted to fit this round in the model's context window — see the tool_use input " +
  'above for what was tried; the original result is still too large together with everything else gathered ' +
  'so far this turn.]'

/**
 * The actual mid-turn collapse `refitConversationToBudget` falls back to —
 * same shape as `capRepeatedToolResults`' own collapse, but ordered purely
 * by conversation position (oldest first) rather than grouped per tool name,
 * since the goal here is "make this fit," not "cap repetition of one tool."
 * Only touches a non-mutating tool's result (a completed mutation is a real
 * side effect worth remembering in full, same reasoning as
 * `capRepeatedToolResults`) that isn't already collapsed (skips anything
 * already short — cheaper than string-comparing every possible placeholder
 * marker, and an already-small result was never the problem). `fits` is
 * called with the cheap rough estimator between each collapse, not a real
 * `countTokens` call, so this stays a single real API call total even when
 * several results need collapsing.
 */
function collapseOldestToolResultsToFit(
  conversation: Message[],
  toolByName: ReadonlyMap<string, Tool>,
  fits: (messages: Message[]) => boolean
): Message[] {
  const toolNameByUseId = new Map<string, string>()
  for (const m of conversation) {
    for (const b of m.content) {
      if (b.type === 'tool_use') toolNameByUseId.set(b.id, b.name)
    }
  }
  const collapsibleIdsInOrder: string[] = []
  for (const m of conversation) {
    for (const b of m.content) {
      if (b.type !== 'tool_result' || b.content.length < 200) continue
      const tool = toolByName.get(toolNameByUseId.get(b.toolUseId) ?? '')
      if (tool && tool.mutates === false) collapsibleIdsInOrder.push(b.toolUseId)
    }
  }

  let working = conversation
  for (const id of collapsibleIdsInOrder) {
    if (fits(working)) break
    working = working.map((m) => ({
      ...m,
      content: m.content.map((b): ContentBlock =>
        b.type === 'tool_result' && b.toolUseId === id ? { ...b, content: CONTEXT_FIT_OMITTED_MARKER } : b
      )
    }))
  }
  return working
}

/** The tool the router calls to hand a step to a specialist. Shared with the roster (roles/roster.ts), which prices each role by it. */
export function buildDelegateToolDefinition(role: AgentRole, label: string, summary: string): ToolDefinition {
  return {
    name: delegateToolName(role),
    description: `Hand off to the ${label} specialist: ${summary}`,
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'What the specialist should do' } },
      required: ['task']
    }
  }
}

export function delegateToolName(role: AgentRole): string {
  return DELEGATE_PREFIX + role.replace(/-/g, '_')
}

function roleFromDelegateName(name: string, agents: Map<AgentRole, Agent>): AgentRole | undefined {
  if (!name.startsWith(DELEGATE_PREFIX)) return undefined
  const slug = name.slice(DELEGATE_PREFIX.length).replace(/_/g, '-') as AgentRole
  return agents.has(slug) ? slug : undefined
}

/** Tags text/tool_use/warning events for UI attribution (the "X agent" chip) — safe at any nesting level, including the top level in forced-role mode. */
function tagEvent(event: StreamEvent, agentRole: AgentRole | undefined): StreamEvent {
  if (!agentRole) return event
  if (event.type === 'text_delta') return { ...event, agentRole }
  if (event.type === 'thinking_delta') return { ...event, agentRole }
  if (event.type === 'tool_use_start') return { ...event, agentRole }
  if (event.type === 'status') return { ...event, agentRole }
  if (event.type === 'warning') return { ...event, agentRole }
  if (event.type === 'image') return { ...event, agentRole }
  return event
}

/**
 * A nested specialist's own message_stop must be distinguishable from the
 * whole exchange truly ending, or the renderer can't tell them apart and
 * stops listening early — found live: a delegated call's own tool_result
 * and the orchestrator's real final reply were both silently dropped
 * because the specialist's own end_turn looked identical to the whole
 * conversation's end_turn. Tagging is keyed on nesting level, not on
 * whether agentRole is set: in forced-role mode the *top-level* call
 * itself carries an agentRole (for the chip), but its own message_stop is
 * still the true final one — found live too, as a stuck "sending" state
 * that never re-enabled the composer after a forced-role reply.
 */
function tagMessageStop(
  event: Extract<StreamEvent, { type: 'message_stop' }>,
  agentRole: AgentRole | undefined,
  isTopLevel: boolean
): StreamEvent {
  return isTopLevel || !agentRole ? event : { ...event, agentRole }
}

interface AccumulatedToolCall {
  id: string
  name: string
  inputJson: string
  thoughtSignature?: string
}

/** Shared across every nesting level of one `run()` call — the round cap, cumulative token usage, and per-round output budget all need to span top-level + every delegate. `deadlineAt` is likewise shared (never reset, even for an isolated delegate's own fresh `roundsUsed`) — a per-slide page-creator call getting its own round budget was never meant to let the *whole turn* run past its own wall-clock cap. */
interface RunState {
  roundsUsed: number
  inputTokens: number
  outputTokens: number
  maxOutputTokens: number
  deadlineAt: number
  /** How many round-timeouts in a row have just happened at this nesting level — reset to 0 the moment a round actually completes, incremented on each timeout. Grows the next round's timeout budget (see `startRoundTimer`) so a retry gets more room than the attempt that just wasn't enough, instead of blindly repeating the same losing timeout forever. */
  consecutiveRoundTimeouts: number
  /** Same idea as `consecutiveRoundTimeouts` above, but for a distinct trigger (TASKS.md #91): a provider-confirmed rate-limit error (429), not a hang. Deliberately separate accounting — a rate-limit wait must never be mistaken for, or share a budget with, a genuinely stuck round. Reset to 0 the moment a round actually completes. */
  consecutiveRateLimitRetries: number
  /** Turn-wide handoff bookkeeping, shared by reference with every nested delegate's state (see `HandoffState`). */
  handoff: HandoffState
}

/**
 * Real outputs of earlier delegates in this turn (design-discussion.md 5.1). One object per turn,
 * shared by reference between a run's state and its nested delegates' states, so a later step is
 * handed the files an earlier step produced and the data it retrieved — not just its prose summary.
 */
interface HandoffState {
  /** Names this turn's capture folder (`.sachiv-handoff/<turnId>/`). */
  turnId: string
  items: HandoffItem[]
  /** Numbers the captured data files across the turn so names never collide. */
  seq: number
  /** How many times a step has been auto-redirected to another role after an `out_of_scope` answer — capped at one per turn so two roles cannot ping-pong. */
  redirects: number
  /** TASKS.md #178: how many times `ensureFollowUpOnIncomplete` has inserted a follow-up step after an `incomplete` answer — capped at one per turn, same reasoning as `redirects`. */
  incompleteFollowUps: number
}

/** What `dispatchDelegate` returns: the text the caller folds into the conversation, plus the typed result behind it. */
interface DelegateOutcome {
  content: string
  isError: boolean
  result?: DelegateResult
}

const MIN_MAX_OUTPUT_TOKENS = 4096 // today's original flat value — kept as the floor, not the ceiling
const OUTPUT_TOKENS_FRACTION = 0.5 // leave room for at least one more similarly-sized round within the same turn

export interface PlanStep {
  role: AgentRole
  description: string
}

interface Plan {
  complexity: 'simple' | 'compound'
  /** TASKS.md #173: a structured, provider-enforced answer to "does this need rules/definitions/standard
   * practice from a wiki/MCP server (or the web)?" — enforced in code (`ensureDomainKnowledgeStep`) rather
   * than left to the model's own `steps` choice reliably matching its own prose rule above. */
  needsDomainKnowledge: boolean
  /** Captured for the same reason as `needsDomainKnowledge`, but not yet enforced — no demonstrated case
   * of a data-needing plan omitting a data step the way #173 omitted a domain-knowledge one; adding
   * enforcement here without a real incident to ground it would be speculative. */
  needsUserData: boolean
  steps: PlanStep[]
}

/** A sub-task's own result folded back into the shared conversation is capped
 * before being added — otherwise plan execution could reintroduce the exact
 * context-bloat failure it exists to prevent (a large `search_history` step
 * result was what triggered the original hallucinated-tool-call bug). */
const STEP_RESULT_CONTEXT_CAP = 2000

/** Captured handoff data older than this is deleted at the start of a turn. */
const HANDOFF_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * A hard ceiling on how many steps a single classify-and-plan pass can hand
 * to `executePlan` — flagged by an external code review (`review.md`,
 * TASKS.md #94): `parsePlan` used to accept any length, and an oversized
 * plan could burn most of the turn's shared round/deadline budget on
 * redundant specialist calls before the final synthesis round even started.
 * Truncated rather than rejected outright — a plan with 8 genuinely
 * reasonable steps is still mostly useful with only the first 5 kept; the
 * caller surfaces a warning so this isn't silent.
 */
/** How many times one round loop re-asks after the model returns nothing at all (no text, no tool call) before reporting it. */
const MAX_EMPTY_RESPONSE_RETRIES = 2

/** Added (for that one retry only, never stored) after an empty round, so the model resumes instead of stopping again. */
const EMPTY_RESPONSE_NUDGE =
  'Your previous reply was empty. Continue with the task: use the tool results above and either call the next tool you need or give your answer in plain text.'

/**
 * TASKS.md #172/#173: found live — a round hit the per-round output-token limit mid-tool-call (gpt-4o-mini
 * writing a Python script, right after being told to read captured data from its handoff file), leaving a
 * garbage/empty tool call (`python_run` with no `code` at all) that would otherwise just end the whole step
 * with "(no response)" — no chance to recover, even though the model usually just needs to be told its
 * output was too long and try again shorter. Bounded the same way `MAX_EMPTY_RESPONSE_RETRIES` is: one
 * retry only, not unlimited, so a model that keeps generating oversized output still fails the round
 * eventually rather than looping forever.
 */
const MAX_TRUNCATED_TOOL_CALL_RETRIES = 1

/**
 * TASKS.md #140/#141: a local reasoning model (gpt-oss especially) can burn its whole output budget on
 * hidden reasoning and return literally no visible text for classify-and-plan's one-shot probe — confirmed
 * live (console: "classify-and-plan response was not valid JSON ... the model returned no text"). Before
 * this, the very first empty reply failed open straight to "no plan," silently losing a compound request's
 * step split with no recovery — unlike `runLoop`'s own round loop, which already retries an empty response
 * (`MAX_EMPTY_RESPONSE_RETRIES`). One retry only (TASKS #141's own stated preference, option (a)) — cheap
 * (one extra call, only on an empty reply) and does not depend on #140's still-open root-cause telemetry.
 */
const MAX_EMPTY_PLAN_RETRIES = 1

const MAX_PLAN_STEPS = 5


/**
 * The JSON Schema the planning reply must satisfy, handed to the provider as structured output (provider-enforced JSON: the reply is
 * constrained to this shape rather than merely requested in the prompt). `role` is limited to the roles a plan may target — the same
 * set `parsePlan` accepts. Kept to the portable subset (object/array/string/enum, `additionalProperties: false`, everything required) that
 * OpenAI strict mode, Gemini, Ollama, Groq, Mistral and an Anthropic tool input schema all take.
 */
export function buildPlanSchema(roleIds: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      complexity: { type: 'string', enum: ['simple', 'compound'] },
      needsDomainKnowledge: {
        type: 'boolean',
        description:
          'Does answering need rules, definitions, or standard practice (from a connected wiki/MCP server, ' +
          'or the web) to interpret the data correctly — e.g. judging whether something is an anomaly, a ' +
          'violation, or matches a named technical concept? True even without the user naming a document.'
      },
      needsUserData: {
        type: 'boolean',
        description: "Does answering need the user's own data — a configured database/API/file — not just general knowledge?"
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: [...roleIds] },
            description: { type: 'string' }
          },
          required: ['role', 'description'],
          additionalProperties: false
        }
      }
    },
    required: ['complexity', 'needsDomainKnowledge', 'needsUserData', 'steps'],
    additionalProperties: false
  }
}

/**
 * Provider/model pairs that rejected the structured-output request (an HTTP error, e.g. a model without schema support). The planning call
 * then goes out as a plain prompt-only request, and stops trying the structured form for that pair for the rest of the app session.
 */
const structuredOutputRejected = new Set<string>()

/**
 * The JSON object in a model's reply, tolerating what local reasoning models actually wrap around it: a ```json fence, or a sentence before
 * and/or after the object. Tries the whole (fence-stripped) text first, then the span from the first `{` to the last `}`.
 */
export function parseJsonObjectLoosely(text: string): any | undefined {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  const candidates = [stripped]
  const first = stripped.indexOf('{')
  const last = stripped.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(stripped.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

/** Fails open to `undefined` (treated as "simple" by the caller) on any parse/shape problem — a broken classifier response must never block the turn it's meant to help. */
export function parsePlan(text: string, validRoles: ReadonlySet<string>): { plan: Plan; truncated: boolean } | undefined {
  try {
    const parsed = parseJsonObjectLoosely(text)
    if (!parsed) return undefined
    if (parsed.complexity !== 'simple' && parsed.complexity !== 'compound') return undefined
    if (!Array.isArray(parsed.steps)) return undefined
    const steps: PlanStep[] = []
    for (const s of parsed.steps) {
      if (typeof s?.description !== 'string' || !s.description.trim()) return undefined
      if (typeof s?.role !== 'string' || !validRoles.has(s.role)) return undefined
      steps.push({ role: s.role as AgentRole, description: s.description })
    }
    const truncated = steps.length > MAX_PLAN_STEPS
    return {
      plan: {
        complexity: parsed.complexity,
        // Defaults to false rather than rejecting the whole plan — the plain-prompt fallback path (a
        // model that rejected structured output) can omit these two newer fields entirely, and a
        // broken/partial classifier response must still fail open to "no domain step inserted," never
        // to "no plan at all" (same reasoning as every other field here).
        needsDomainKnowledge: parsed.needsDomainKnowledge === true,
        needsUserData: parsed.needsUserData === true,
        steps: truncated ? steps.slice(0, MAX_PLAN_STEPS) : steps
      },
      truncated
    }
  } catch {
    return undefined
  }
}

/**
 * The Orchestrator owns the conversation: it can act directly with its own
 * default tools, or delegate a step to a specialized Agent (sequential
 * hand-off, no concurrent agents — see thouthts.md). Delegation is modeled
 * as an ordinary tool call (`delegate_to_<role>`) rather than a separate
 * routing phase, so it reuses the same proven multi-round tool-call loop
 * (streaming, human-in-loop confirmation, a shared round-safety-cap) at
 * every nesting level instead of a second parallel state machine. Nested
 * specialists don't get delegate tools themselves, so recursion is capped
 * at exactly one level.
 */
export class Orchestrator {
  constructor(
    private readonly provider: ModelProvider,
    private readonly model: string,
    private readonly agents: Map<AgentRole, Agent>,
    private readonly defaultSystemPrompt: string,
    private readonly defaultTools: Tool[],
    private readonly confirmTool: (request: ToolConfirmRequest) => Promise<ConfirmDecision>,
    private readonly toolContext: ToolContext,
    private readonly signal: AbortSignal,
    /**
     * `planningEnabled` defaults to disabled so existing/unit-test callers
     * that construct an Orchestrator directly without scripting an extra
     * classify turn keep working unchanged — the real app (ipc/register.ts)
     * always passes this explicitly, computed from the persisted
     * `planningEnabled` setting (default on there, not here).
     *
     * `confirmContinue` defaults to absent, in which case runLoop's
     * exhaustion handling falls straight to today's existing wrap-up
     * behavior unchanged — every existing caller/test that doesn't pass it
     * keeps working exactly as before; only a caller that wants the
     * ask-before-abandoning behavior needs to provide it.
     *
     * `logClassifyGateSample` defaults to absent (a no-op) — see TASKS.md
     * #95: every time `classifyAndPlan`'s real classifier call actually
     * runs, this is handed the deterministic gate's own verdict alongside
     * the real result, purely for the calibration logging ipc/register.ts
     * wires to `db/classify-gate-log.ts`. Optional/no-op by default so
     * every existing caller/test that doesn't care about calibration data
     * keeps working unchanged — this file stays DB-free either way (see
     * this class's own doc comment).
     */
    private readonly options: {
      planningEnabled: boolean
      confirmContinue?: (request: LimitReachedRequest) => Promise<LimitDecision>
      logClassifyGateSample?: (sample: {
        gateVerdict: ClassifyGateVerdict
        classifierComplexity: 'simple' | 'compound' | 'unknown'
        messageLength: number
      }) => void
      /**
       * Live configuration counts (databases / APIs / email accounts) for the classifier's role digest, so a plan never routes
       * "email it to X" to a role with no account to send from. Absent (tests) = assume every role's requirements are met.
       */
      getConfiguration?: () => ConfigurationCounts
      /**
       * Called for every real tool call (`agentRole` undefined = the router itself). Local usage counts keep the slim router's hot
       * core honest (design 3.1). Optional/no-op by default — this file stays DB-free (see this class's own doc comment).
       */
      logToolUse?: (sample: { tool: string; agentRole: string }) => void
      /**
       * TASKS.md #158: returns and clears whatever mid-run steering comments have arrived since the last
       * drain — polled non-blockingly at the top of every TOP-LEVEL round (never a nested specialist's own
       * rounds; delegation is structurally one level only, and routing a steering comment down through an
       * active delegate call is real additional scope this pass doesn't cover). Optional/absent (tests,
       * anything that doesn't care) = no-op, matching every other optional callback here. `runLoop` persists
       * a drained comment itself via the same `yield { kind: 'message', ... }` path every other message
       * already goes through (ipc/register.ts's generic insertMessage/enqueueMessage handling) — this file
       * never calls a DB function directly, same as always. A comment submitted but never drained (the run
       * ends before its next round starts) is a known, accepted gap for this first pass.
       */
      drainSteeringComments?: () => string[]
      /**
       * 0..1, forwarded unchanged to every `provider.stream()` call this turn makes (classify, every
       * round, the wrap-up). Absent = send nothing, the provider's own default applies — unlike every
       * other optional callback here, this isn't DB-free-file plumbing, it is itself the actual value
       * (ipc/register.ts reads it from Settings > Model behavior once per turn and passes it straight
       * through), so there is no separate getter to keep this file DB-free with.
       */
      temperature?: number
    } = { planningEnabled: false }
  ) {}

  /**
   * A per-round AbortSignal that fires on whichever comes first: the real
   * user/turn-level `this.signal`, or this round's own timeout budget
   * elapsing. Every `provider.stream()` call site passes `roundSignal`
   * instead of `this.signal` directly, and checks `roundSignal.aborted`
   * (not `this.signal.aborted`) in its catch block — so a timeout is
   * handled by the exact same, already-tested "clean abort" path a real
   * Stop click already goes through, not a new/parallel one. `timedOut()`
   * lets the caller tell the two apart afterward, only to choose a more
   * honest message ("this took too long" vs "you stopped it") — never to
   * change the control flow itself. Always call `clear()` once the round's
   * own stream has actually finished (in a `finally`), or the timer leaks
   * and can fire long after the round it was guarding is already done.
   *
   * The budget is adaptive, not the flat `ROUND_TIMEOUT_MS` for every
   * attempt: `consecutiveRoundTimeouts` (how many times in a row this exact
   * round has just been retried after timing out) roughly doubles the
   * ceiling each time, so a round that's merely slow — not hung — gets
   * more room on each retry instead of being killed at the identical point
   * forever. Still bounded by the actual remaining turn budget (with a
   * safety margin reserved for whatever runs next) and a floor so even a
   * round started with almost no time left gets a workable window.
   */
  private startRoundTimer(
    deadlineAt: number,
    consecutiveRoundTimeouts: number
  ): { signal: AbortSignal; timedOut: () => boolean; clear: () => void; budgetMs: number } {
    if (this.signal.aborted) {
      return { signal: this.signal, timedOut: () => false, clear: () => {}, budgetMs: 0 }
    }
    const controller = new AbortController()
    let didTimeOut = false
    const onParentAbort = (): void => controller.abort()
    this.signal.addEventListener('abort', onParentAbort, { once: true })
    const remaining = deadlineAt - Date.now()
    const budgetMs = Math.max(
      ROUND_TIMEOUT_FLOOR_MS,
      Math.min(remaining - ROUND_TIMEOUT_SAFETY_MARGIN_MS, ROUND_TIMEOUT_MS * (consecutiveRoundTimeouts + 1))
    )
    const timer = setTimeout(() => {
      didTimeOut = true
      controller.abort()
    }, budgetMs)
    return {
      signal: controller.signal,
      timedOut: () => didTimeOut,
      budgetMs,
      clear: () => {
        clearTimeout(timer)
        this.signal.removeEventListener('abort', onParentAbort)
      }
    }
  }

  /**
   * Runs one user turn. If `forcedRole` is set (manual override — see
   * TASKS.md orchestrator plan), skips the orchestrator's own routing
   * entirely and runs that specialist directly, with no delegate tools of
   * its own available. Otherwise (Auto mode), optionally runs a
   * classify-and-plan pass first (see `classifyAndPlan`) — a genuinely
   * compound result routes through `executePlan`'s structured step
   * execution instead of pure round-by-round improvisation; anything else
   * (simple, planning disabled, or a failed/malformed classification) falls
   * straight through to the same behavior this always had.
   */
  async *run(conversation: Message[], forcedRole?: AgentRole | null): AsyncIterable<OrchestratorEvent> {
    const maxOutputTokens = await this.resolveMaxOutputTokens(conversation)
    const state: RunState = {
      roundsUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      maxOutputTokens,
      deadlineAt: Date.now() + TURN_DEADLINE_MS,
      consecutiveRoundTimeouts: 0,
      consecutiveRateLimitRetries: 0,
      handoff: { turnId: randomUUID().slice(0, 8), items: [], seq: 0, redirects: 0, incompleteFollowUps: 0 }
    }
    // Old captured-data folders are only useful within (roughly) the turn that made them.
    const workspaceRoot = this.toolContext.workspaceGuard?.root
    if (workspaceRoot) void pruneHandoffDirs(workspaceRoot, HANDOFF_RETENTION_MS)

    // A pinned role that does not resolve — a user-defined role since deleted or disabled, or a stale pin — falls back to Auto with a
    // visible notice instead of failing the turn (design 11.4). Roles are an open string set now, so this can genuinely happen.
    let pinned = forcedRole
    if (pinned && !this.agents.has(pinned)) {
      const message = `The pinned "${this.labelOf(pinned)}" agent is not available (it may have been removed or disabled) — using Auto instead.`
      yield { kind: 'stream', event: { type: 'warning', message } }
      yield { kind: 'message', role: 'assistant', content: [{ type: 'warning', message }] }
      pinned = null
    }
    if (pinned) {
      const agent = this.agents.get(pinned) as Agent
      const systemPrompt = agent.systemPrompt + this.buildForcedModeNotice(pinned)
      yield* this.runLoop(systemPrompt, agent.tools, conversation, state, pinned, [], true)
      return
    }

    // Phase 1 of TASKS.md #95: a cheap deterministic pre-check ahead of the
    // real classifier call — 'skip' only fires on an unambiguous, short,
    // single-clause message (see classify-gate.ts), so this never decides
    // "compound" itself, only whether the real call is worth skipping.
    // Phase 2: even a 'skip' verdict is sometimes overridden anyway
    // (shouldSampleForCalibration) purely so the real classifier still runs
    // and its result can be logged against the gate's own verdict — see
    // classifyAndPlan's own logging call below.
    const gateVerdict: ClassifyGateVerdict = this.options.planningEnabled
      ? evaluateClassifyGate(latestMessageText(conversation))
      : 'run'
    const shouldClassify = this.options.planningEnabled && (gateVerdict !== 'skip' || shouldSampleForCalibration())
    const plan = shouldClassify ? yield* this.classifyAndPlan(conversation, state, gateVerdict) : undefined

    // Stop clicked while classifyAndPlan's own request was in flight: it
    // already swallowed that abort quietly and returned `undefined` (same
    // shape as "no plan needed"), relying on *this* check to actually end
    // the turn — found live: without it, an aborted classify pass fell
    // straight through into a brand-new full round below, silently
    // discarding the user's Stop and spending a whole extra model call
    // (with its own visible "round 1" status flicker) before anything
    // acknowledged the cancellation. Scoped to `shouldClassify` specifically
    // — with planning off, or the gate skipping the classify call entirely,
    // `plan` is `undefined` because there was never a classify call to
    // abort, and runLoop below is the *first* real attempt this turn; it
    // must still run so its own status/abort handling fires normally (a
    // signal already aborted before the user even sent this turn is a real,
    // if rare, case that existing behavior already covers).
    if (shouldClassify && this.signal.aborted) {
      // TASKS.md #102: nothing ever ran past the classify pre-pass, so
      // there's genuinely nothing else to persist for this turn — same
      // top-level "stopped, no answer" note as runLoop's own abort branches.
      yield* this.emitStoppedNoAnswer(undefined)
      yield { kind: 'stream', event: tagMessageStop({ type: 'message_stop', stopReason: 'aborted' }, undefined, true) }
      return
    }

    // TASKS.md #173: a single-step plan normally skips executePlan entirely (the plain top-level round
    // already covers it) — but if that one step omitted a needed domain-knowledge step, it must still go
    // through executePlan, where ensureDomainKnowledgeStep actually inserts it; otherwise this whole fix
    // would never fire for the common case of a model planning just one (non-mcp-operator) step.
    if (!plan || (plan.steps.length <= 1 && !this.shouldInsertDomainKnowledgeStep(plan))) {
      yield* this.runLoop(
        this.buildOrchestratorSystemPrompt(),
        this.defaultTools,
        conversation,
        state,
        undefined,
        this.buildDelegateToolDefinitions(),
        true
      )
      return
    }

    yield* this.executePlan(plan, conversation, state)
  }

  /**
   * The per-round output-token ceiling. Was a single flat `4096` forever,
   * for every provider/model/round, unrelated to any real capacity — found
   * live that this starved `gpt-oss` into an empty response
   * (`finish_reason: "length"`, zero visible output; its hidden
   * chain-of-thought reasoning counts against `maxTokens` before any
   * visible output is produced), and separately, confirmed against each
   * provider's own current docs that ordinary cloud replies had been capped
   * to a fraction of their real ceiling the whole time (e.g. Claude Sonnet
   * 5/Opus 5 really allow 128,000).
   *
   * Now: `maxOutputTokensFor(this.model)` (model-metadata.ts) gives the
   * real, provider-enforced ceiling — this is a hard clamp, never exceeded,
   * so a cloud model never gets asked for more than it actually accepts (a
   * new class of hard API error otherwise). The *budget* within that
   * ceiling scales off how much of the model's context window is actually
   * free: a live reading when a provider can give one (today, Ollama's
   * `loadedContextWindow`, a real `/api/ps` read of what's actually
   * loaded), else the same static estimate `prepare-context.ts` already
   * uses for input-side trimming.
   *
   * Also subtracts real overhead (system prompt + tool schemas) before
   * computing what's left — flagged by an external code review (`review.md`,
   * TASKS.md #97): this used to only subtract `countTokens(conversation)`,
   * so the `MIN_MAX_OUTPUT_TOKENS` floor could still request more output
   * than was actually free once the system prompt and tool definitions sent
   * in the same request were accounted for, especially for a small local
   * model's context window. Reuses `overheadTokens` (`prepare-context.ts`,
   * already built for #51's input-side trim) rather than a second estimator.
   * The exact system prompt/tool set used varies per round (forced-role vs.
   * Auto, a specialist's own smaller tool list, the classify pass's empty
   * one) but `state.maxOutputTokens` is computed once and shared across
   * every round and every nested delegate call in the whole run (see
   * `RunState`) — so the top-level orchestrator's own prompt plus the full
   * default tool registry (`buildOrchestratorSystemPrompt`/`defaultTools`)
   * is used as the worst-case (largest) overhead estimate every round
   * actually uses, which only ever makes the budget more conservative for a
   * smaller specialist prompt/tool set, never short of what's really free.
   *
   * `countTokens` is a real network call for Anthropic/Google — now two per
   * turn (conversation + overhead), not one, but still only at `run()`
   * startup, not per round, matching the cost this app already pays during
   * history trimming before the Orchestrator is even constructed.
   */
  private async resolveMaxOutputTokens(conversation: Message[]): Promise<number> {
    const ceiling = maxOutputTokensFor(this.model).tokens
    const loaded = await this.provider.loadedContextWindow?.(this.model)
    const windowTokens = loaded ?? contextWindowFor(this.model).tokens
    const used = await this.provider.countTokens(conversation, this.model)
    const overhead = await overheadTokens(
      { system: this.buildOrchestratorSystemPrompt(), tools: toToolDefs(this.defaultTools) },
      this.model,
      this.provider
    )
    const remaining = Math.max(0, windowTokens - used - overhead)
    const budget = Math.floor(remaining * OUTPUT_TOKENS_FRACTION)
    return Math.min(ceiling, Math.max(MIN_MAX_OUTPUT_TOKENS, budget))
  }

  /**
   * Re-fits the conversation against the context window before every
   * provider request, not just once via `prepareConversation` before the
   * turn starts — flagged by an external code review (`review.md`,
   * TASKS.md #98): `capRepeatedToolResults`/`collapseDuplicateToolResults`
   * already dedupe by tool name and URL overlap, but nothing previously
   * re-checked *total* conversation size mid-turn, so `executePlan`'s
   * appended step results or an ordinary long multi-round tool-call
   * sequence could each individually stay under their local caps while the
   * sum still pushed a later round's request over the model's real context
   * window.
   *
   * Deliberately two-tier to avoid turning every single round into an extra
   * real network call: `roughTokenEstimate` (a cheap, local, conservative
   * char-count approximation) decides whether the *real* `countTokens` check
   * even needs to run at all, so an ordinary short conversation — the
   * overwhelming majority of rounds — returns immediately with zero added
   * cost or latency. Only once the rough estimate suggests real risk does
   * this spend a real `countTokens` call (a genuine network request for
   * Anthropic/Google) to confirm, and only then collapse the oldest
   * still-expanded, non-mutating tool results (oldest first, cheapest-to-
   * re-fetch-if-still-needed) until it's estimated to fit — re-measured with
   * the same cheap local estimator between collapses, never a real call per
   * collapse, so this stays at most one real `countTokens` call per round
   * even in a turn that needs several results collapsed.
   */
  private async refitConversationToBudget(
    messages: Message[],
    toolByName: ReadonlyMap<string, Tool>,
    systemPrompt: string,
    toolDefs: ToolDefinition[],
    state: RunState
  ): Promise<Message[]> {
    const contextWindow = await resolveContextWindow(this.model, this.provider)
    const roughBudget = Math.floor(contextWindow.tokens * CONTEXT_BUDGET_FRACTION) - state.maxOutputTokens
    if (roughTokenEstimate(messages) <= roughBudget) return messages

    const overhead = await overheadTokens({ system: systemPrompt, tools: toolDefs }, this.model, this.provider)
    const budget = Math.max(0, roughBudget - overhead)
    const actual = await this.provider.countTokens(messages, this.model)
    if (actual <= budget) return messages

    return collapseOldestToolResultsToFit(messages, toolByName, (candidate) => roughTokenEstimate(candidate) <= budget)
  }

  /**
   * One dedicated, tool-free call ahead of the normal round loop — asks the
   * model to judge whether the request needs more than one distinct
   * sub-task and, if so, produce an ordered step list up front. Found live:
   * a genuinely compound request could wander into an irrelevant,
   * hallucinated tool call once retrieved context grew large mid-turn —
   * this replaces that per-round discretion with a structural, upfront
   * gate. Counts against the same shared `state.roundsUsed` cap as every
   * other round. A genuine provider failure rethrows (surfaced like any
   * other error, same as `runLoop`); an aborted signal returns `undefined`
   * quietly, since the very next `runLoop`/`dispatchDelegate` call will hit
   * the same aborted signal and produce the real "aborted" stop event.
   *
   * Sends only the latest message, not the full conversation — found live,
   * repeatedly, against the real default model (gpt-oss): given the full
   * history (which, past the first turn, always includes an earlier
   * tool_use/tool_result exchange and a natural-language assistant reply),
   * it would drift into just answering the user's question directly,
   * completely ignoring the classify instruction — confirmed directly
   * against the real server across several trials, ~0% valid-JSON rate
   * with full history vs. ~85% with just the latest message alone. The
   * classify task only needs the current request's own phrasing to judge
   * structural complexity; the full history actively hurts reliability
   * here by giving the model an established "just chat" pattern to fall
   * back into instead of the structured-output task.
   */
  private async *classifyAndPlan(
    conversation: Message[],
    state: RunState,
    gateVerdict: ClassifyGateVerdict
  ): AsyncGenerator<OrchestratorEvent, Plan | undefined> {
    state.roundsUsed++
    let text = ''
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' = 'end_turn'
    let roundUsage: { inputTokens: number; outputTokens: number } | undefined
    const latestMessage = conversation[conversation.length - 1]

    // Provider-enforced JSON where the provider supports it (see StructuredOutputRequest). If the provider/model rejects the request, the same
    // call is repeated once as a plain prompt-only request and the pair is remembered, so a model without schema support costs one failed call
    // per app session, not one per message.
    const structuredKey = `${this.provider.id}:${this.model}`
    let structured = !structuredOutputRejected.has(structuredKey)
    let emptyPlanRetries = 0
    let parsed: ReturnType<typeof parsePlan>
    let plan: Plan | undefined

    // Outer loop: retries once on a genuinely empty reply (TASKS #140/#141) — distinct from the inner
    // loop just below, which retries (also via `continue`, its own separate concern) when the provider
    // rejects structured output outright and falls back to a plain prompt.
    outer: for (;;) {
      for (;;) {
        text = ''
        stopReason = 'end_turn'
        roundUsage = undefined
        // Always a fresh (non-retried) budget — this is a one-shot probe that
        // falls open on timeout rather than retrying, so the adaptive growth
        // that a real retry loop gets doesn't apply here.
        const roundTimer = this.startRoundTimer(state.deadlineAt, 0)
        try {
          for await (const event of this.provider.stream({
            model: this.model,
            system: this.buildClassifySystemPrompt(),
            messages: latestMessage ? [latestMessage] : conversation,
            // Shares the same real, scaled-when-possible budget as every other
            // round (see resolveMaxOutputTokens) — a flat small value here
            // starved gpt-oss's hidden reasoning into an empty response before
            // this existed (finish_reason:"length", 0 visible chars).
            maxTokens: state.maxOutputTokens,
            signal: roundTimer.signal,
            temperature: this.options.temperature,
            ...(structured ? { structuredOutput: { name: 'classify_and_plan', schema: buildPlanSchema(this.plannableRoleIds()) } } : {})
          })) {
            if (event.type === 'text_delta') text += event.text
            else if (event.type === 'usage') roundUsage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
            else if (event.type === 'message_stop') stopReason = event.stopReason
          }
          break
        } catch (err) {
          // TASKS.md #91: a rate limit here falls open the same way a timeout
          // already does, just below — no retry loop for a one-shot probe (the
          // real round loop right after this gets the full retry treatment via
          // handleRateLimitError, and will hit the identical rate limit again
          // immediately if it's still in effect, at which point it's handled
          // properly rather than twice over in two different ways here).
          if (isRateLimitError(err)) return undefined
          if (!roundTimer.signal.aborted) {
            // Only a client-error rejection (400/404/422 — the request shape or the model does not support it) counts; auth failures, rate limits,
            // network errors and 5xx are not the schema's fault and rethrow as before.
            const status = (err as { status?: number }).status
            if (structured && (status === 400 || status === 404 || status === 422)) {
              structuredOutputRejected.add(structuredKey)
              structured = false
              console.error(
                `orchestrator: ${structuredKey} rejected structured output for the planning call (${err instanceof Error ? err.message : String(err)}) — retrying it as a plain prompt`
              )
              continue
            }
            throw err
          }
          // A timed-out classify call falls open exactly like a genuinely
          // malformed one already does (see the no-plan branch below) — it's
          // a probe, not the real answer, so there's nothing here worth
          // surfacing beyond just proceeding without a plan.
          return undefined
        } finally {
          roundTimer.clear()
        }
      }

      if (roundUsage) {
        state.inputTokens += roundUsage.inputTokens
        state.outputTokens += roundUsage.outputTokens
        yield { kind: 'stream', event: { type: 'usage', ...roundUsage } }
      }

      parsed = parsePlan(text, new Set(this.plannableRoleIds()))
      plan = parsed?.plan

      // A genuinely empty reply (no text, no tool call, not cut off by the token limit) is the specific
      // hidden-reasoning-exhaustion symptom, not an ordinary "chose not to plan" result — worth one retry
      // before accepting it and falling open. A non-empty-but-unparseable reply (prose, a fenced block,
      // malformed JSON) is left alone here; that is the routine, expected case already handled below.
      if (!plan && stopReason !== 'max_tokens' && text.trim() === '' && emptyPlanRetries < MAX_EMPTY_PLAN_RETRIES) {
        emptyPlanRetries++
        console.error('orchestrator: classify-and-plan returned no text at all — retrying once before falling open to no plan')
        continue outer
      }
      break
    }

    if (parsed?.truncated) {
      const message =
        `This request's plan had more steps than the ${MAX_PLAN_STEPS}-step limit — proceeding with just the ` +
        'first ones; the rest of the request may need a follow-up turn.'
      yield { kind: 'stream', event: { type: 'warning', message } }
      yield { kind: 'message', role: 'assistant', content: [{ type: 'warning', message }] }
    }
    if (!plan) {
      if (stopReason === 'max_tokens') {
        // Surfaced to the user, not just logged — this is the one real
        // correctness concern the classify pass can hit: a genuinely
        // empty/cut-off response (hit the output-token limit) used to be
        // silently indistinguishable from "the model decided nothing
        // needed planning," hiding a real bug. Fail-open (proceed as a
        // normal request) is still the right recovery either way.
        const message =
          "Couldn't tell whether this request is simple or compound (the classification response was cut off " +
          'before it could finish, hitting the output-token limit) — treating it as a normal request instead.'
        yield { kind: 'stream', event: { type: 'warning', message } }
        yield { kind: 'message', role: 'assistant', content: [{ type: 'warning', message }] }
      } else {
        // A local model (gpt-oss especially) not returning valid JSON for
        // this structured-output probe is the *expected*, routine case, not
        // a real problem — fail-open the same way, but only to the console,
        // not the chat transcript. Reported directly: a persisted warning
        // here had no actionable next step for the user and just read as
        // noise on every turn it happened to fire.
        console.error(
          'orchestrator: classify-and-plan response was not valid JSON, treating as a normal request' +
            (text.trim() ? ` — the model said: ${JSON.stringify(text.trim().slice(0, 300))}` : ' — the model returned no text')
        )
      }
    }
    // Phase 2 of TASKS.md #95 — a real classifier response, whatever it was
    // (including "unparseable"), logged alongside the gate's own verdict for
    // this turn. Only reached once the call actually completed (the
    // timeout/abort path above returns before this), so this never logs a
    // probe that never got a real answer.
    this.options.logClassifyGateSample?.({
      gateVerdict,
      classifierComplexity: plan?.complexity ?? 'unknown',
      messageLength: latestMessageText(conversation).length
    })
    return plan
  }

  /**
   * design-discussion.md §13.3, TASKS #145/#146: whether an MCP server is connected at all is a fact
   * known before any model runs — `ConfigurationCounts.mcp === 0` — not a judgment call, so it isn't left
   * to the classifier or the top-level model reliably noticing `buildRoleDigest`'s "UNAVAILABLE right
   * now" note (`parsePlan` only validates role-id membership, never live availability; an unheeded note
   * used to mean the step, or a direct `delegate_to_mcp-operator` tool call, just ran anyway and wasted
   * itself on "no connected server fits"). A request for `mcp-operator` while none is connected is
   * rewritten to `research` here, with a code-inserted note carrying the substitution's purpose and the
   * same "say plainly, don't guess" honesty Researcher's prompt already uses for its no-Tavily-key case.
   * Shared by both entry points that can route to a role — a compound plan's own step (`executePlan`,
   * #145) and the top-level round's direct tool-call delegation (#146) — so the availability check and
   * the note's wording live in exactly one place. Distinct from the connected-but-nothing-relevant case
   * (TASKS #143/#144), which genuinely can only be judged by a model that looked, so it stays a
   * self-reported handoff tag instead of a code check.
   */
  private substituteUnavailableMcpOperator(role: AgentRole, description: string): { role: AgentRole; description: string } {
    const mcpAgent = this.agents.get('mcp-operator')
    if (role !== 'mcp-operator' || !mcpAgent || !this.agents.has('research') || isRoleAvailable(mcpAgent, this.options.getConfiguration?.())) {
      return { role, description }
    }
    return {
      role: 'research',
      description:
        'No MCP/knowledge-base server is connected right now, so treat this as an open-web substitute for ' +
        "domain or process knowledge that would normally come from a connected wiki. Say plainly if nothing " +
        `genuinely relevant turns up, rather than guessing. Original task: ${description}`
    }
  }

  private applyMcpAvailabilityFallback(steps: readonly PlanStep[]): PlanStep[] {
    return steps.map((step) => {
      const substituted = this.substituteUnavailableMcpOperator(step.role, step.description)
      return substituted.role === step.role ? step : substituted
    })
  }

  /**
   * TASKS.md #173: found live — a real connected wiki had directly relevant content (a loss-taxonomy
   * document covering exactly "yaw misalignment" and "power curve adjustment") for a question asking to
   * interpret turbine telemetry against both, and the planner's own step list never included an
   * `mcp-operator` step at all, on two different models (local and cloud), despite the planning prompt's
   * existing prose rule saying this should always be compound. Moving the judgment into `needsDomainKnowledge`
   * (a structured field the planner must explicitly answer, same mechanism `complexity` already uses) and
   * enforcing it here in code closes the gap regardless of whether a given model's own step list honored
   * the prose. Only inserts when a server is actually connected — the no-server case is
   * `substituteUnavailableMcpOperator`'s job, not this one's, and inserting a step that can't run would
   * just waste a round on "no connected server fits." A no-op if the planner already included its own
   * `mcp-operator` step, so this never produces a duplicate.
   */
  /** Split out from `ensureDomainKnowledgeStep` so the "is this plan really just 1 step" gate (below, where
   * `executePlan` vs. the plain single-round path is decided) can know a step is coming *before* any
   * conversation text is needed, not just at insertion time. */
  private shouldInsertDomainKnowledgeStep(plan: Plan): boolean {
    const mcpAgent = this.agents.get('mcp-operator')
    const alreadyPlanned = plan.steps.some((s) => s.role === 'mcp-operator')
    return plan.needsDomainKnowledge && !alreadyPlanned && !!mcpAgent && isRoleAvailable(mcpAgent, this.options.getConfiguration?.())
  }

  private ensureDomainKnowledgeStep(plan: Plan, conversation: Message[]): PlanStep[] {
    if (!this.shouldInsertDomainKnowledgeStep(plan)) return plan.steps
    const request = latestMessageText(conversation)
    const inserted: PlanStep = {
      role: 'mcp-operator',
      description:
        "Look up domain knowledge (rules, definitions, standard practice) relevant to the user's request, " +
        `via the connected wiki/MCP server(s), for a later step to use. Original request: ${request}`
    }
    return [inserted, ...plan.steps]
  }

  /**
   * TASKS.md #178: `no_information` (MCP found nothing at all relevant) already had a fallback — a note
   * hoping a later round picks up `web_search` on its own (see the `fallbackNote` logic in `executePlan`
   * below). `incomplete` (found *something*, but not enough — e.g. the right document, but only a table
   * fragment or a citation, not real usable content) gets a stronger, code-enforced version: insert one
   * real follow-up step into the plan itself, right here, rather than leaving it to a passive note —
   * found live, a hopeful note is exactly how a partial result slips through uncorrected (the original
   * `no_information` fallback note never actually fires for a status that was never reported as
   * `no_information` in the first place, since the step technically found *something*). Bounded by
   * `state.handoff.incompleteFollowUps` (capped at 1 per turn, same `redirects`-style cap this file
   * already uses for `out_of_scope`) so an incomplete-on-the-follow-up-too case can't ping-pong forever —
   * past that point it's the final synthesis's job (`buildOrchestratorSystemPrompt`) to disclose the
   * remaining gap, not this mechanism's job to keep retrying. One-directional only: MCP Operator
   * incomplete -> Research follow-up. The reverse isn't built — no live incident motivates it, and by
   * the time a Research step runs at all, `ensureDomainKnowledgeStep` has usually already tried MCP
   * Operator first if one was connected.
   */
  private ensureFollowUpOnIncomplete(
    steps: PlanStep[],
    afterIndex: number,
    fromRole: AgentRole,
    originalDescription: string,
    state: RunState
  ): boolean {
    if (fromRole !== 'mcp-operator' || !this.agents.has('research') || state.handoff.incompleteFollowUps >= 1) {
      return false
    }
    state.handoff.incompleteFollowUps++
    steps.splice(afterIndex + 1, 0, {
      role: 'research',
      description:
        'The connected wiki/knowledge base had partial but incomplete information for the previous step: ' +
        `"${originalDescription}" — search the open web to fill the specific gap, and say plainly in your ` +
        'own result what you found versus what is still unconfirmed.'
    })
    return true
  }

  /**
   * Walks a compound plan's steps in order, each one dispatched exactly
   * like today's single delegate call, then runs one final top-level round
   * so the model can synthesize everything the steps produced into the
   * actual answer. `plan`/`plan_step_start`/`plan_step_done` are live-only
   * UI signal — the real content of each step is already a normal
   * persisted message via the same `dispatchDelegate` machinery every other
   * delegated round already uses, so a reloaded session still shows the
   * full text even though the live checklist animation doesn't replay.
   */
  private async *executePlan(plan: Plan, conversation: Message[], state: RunState): AsyncIterable<OrchestratorEvent> {
    const steps = this.applyMcpAvailabilityFallback(this.ensureDomainKnowledgeStep(plan, conversation))
    // Computed once, before any step message is pushed onto `conversation` — by the time a later step
    // runs, its last entry would be the previous step's own message, not the user's original request.
    const sourcingRestricted = detectsSourceRestriction(latestMessageText(conversation))
    yield { kind: 'stream', event: { type: 'plan', steps } }

    for (const [index, step] of steps.entries()) {
      yield { kind: 'stream', event: { type: 'plan_step_start', index } }
      let role = step.role
      const planContext = { index, total: steps.length }
      let outcome = yield* this.dispatchDelegate(role, { task: step.description }, conversation, state, planContext)

      // out_of_scope → redirect ONCE per turn to the role the specialist named (5.2). A second
      // out_of_scope, a suggestion that is not a real role, or a real-but-not-plannable role (e.g.
      // page-creator — isolated, fixed one-slide brief shape, never a sane target for an arbitrary
      // step description) is left as-is for the final round to explain. Found live: Document Creator
      // declined an image-embedding step and, despite its own prompt naming "the Developer", picked
      // "page-creator" instead — a syntactically valid agent id but a dead end for a Word document.
      const suggested = outcome.result?.suggestedRole
      if (
        outcome.result?.status === 'out_of_scope' &&
        suggested &&
        suggested !== role &&
        this.plannableRoleIds().includes(suggested) &&
        state.handoff.redirects < 1
      ) {
        state.handoff.redirects++
        yield { kind: 'stream', event: { type: 'status', message: `${this.labelOf(role)} handed this to ${this.labelOf(suggested as AgentRole)}…` } }
        role = suggested as AgentRole
        outcome = yield* this.dispatchDelegate(role, { task: step.description }, conversation, state, planContext)
      }
      yield { kind: 'stream', event: { type: 'plan_step_done', index, isError: outcome.isError } }

      // Truncate only the specialist's own text: the app-derived sections (files, captured data, status)
      // are appended after it and must never be the part that gets cut.
      const d = outcome.result
      const trimmed = d
        ? formatDelegateResult({ ...d, summary: d.summary.length > STEP_RESULT_CONTEXT_CAP ? d.summary.slice(0, STEP_RESULT_CONTEXT_CAP) + '\n[...truncated for context budget...]' : d.summary })
        : outcome.content
      // `outcome.isError` used to only reach the renderer (the plan_step_done event just above, for its
      // ✓/✗ UI) — the text below, the only copy of this step's outcome any later step or the final
      // synthesis round actually sees, formatted a failure identically to a real result. The explicit
      // (FAILED...) marker is what a step actually reacts to.
      const marker = outcome.isError
        ? ' (FAILED — no usable result)'
        : d?.status === 'needs_input'
          ? ' (NEEDS INPUT — plan paused)'
          : d?.status === 'out_of_scope'
            ? ' (OUT OF SCOPE — not done)'
            : d?.status === 'no_information'
              ? ' (NO INFORMATION FOUND — nothing relevant in the connected source)'
              : d?.status === 'incomplete'
                ? ' (PARTIAL INFORMATION — found something, but not enough)'
                : ''
      // TASKS.md #178: unlike `no_information`'s fallback (a note only, below), an `incomplete` result
      // gets a real, code-inserted follow-up step when one is available — computed here, before the
      // note text, so the note can honestly say whether a follow-up is actually coming.
      const insertedFollowUp =
        d?.status === 'incomplete' && !sourcingRestricted ? this.ensureFollowUpOnIncomplete(steps, index, role, step.description, state) : false
      // design-discussion.md §13.2(c),(d), §13.5, TASKS #144: a `no_information` step's own text is where
      // a later step or the final round gets its ONLY view of what happened here — so the fallback
      // permission and the provenance requirement both have to live in this same code-inserted text, not
      // in a separate instruction hoping a later round remembers it. Deliberately silent (no note either
      // way) for every other status, and for `no_information` itself when the user's own request already
      // restricted sourcing — firing the fallback then would be its own kind of unrequested action.
      const fallbackNote =
        d?.status === 'no_information' && !sourcingRestricted && this.agents.has('research')
          ? '\n\n(Nothing relevant was found in the connected wiki/knowledge base. A later step or your final answer may use ' +
            'web_search or delegate_to_research to look for this on the open web instead. If that turns up something, say so ' +
            "plainly in the final answer — state that the connected wiki had nothing on this and the information came from the " +
            'web instead, rather than presenting it as verified from the wiki.)'
          : d?.status === 'no_information' && sourcingRestricted
            ? '\n\n(The user\'s own request restricts where this information may come from, so no web fallback should be attempted ' +
              'here — report plainly that the connected source had nothing on this and stop.)'
            : d?.status === 'incomplete' && sourcingRestricted
              ? '\n\n(The user\'s own request restricts where this information may come from, so no follow-up to another source ' +
                'should be attempted here — report plainly that this source only had partial information and stop.)'
              : d?.status === 'incomplete' && insertedFollowUp
                ? '\n\n(This source had only partial information — a follow-up step has been added to fill the gap from another ' +
                  'source. The final answer must still say plainly what came from where if the two disagree or only partly overlap.)'
                : d?.status === 'incomplete'
                  ? '\n\n(This source had only partial information, and no further source is available to fill the gap — your ' +
                    'final answer must say plainly what could and could not be confirmed, rather than presenting this partial ' +
                    'result as a complete answer.)'
                  : ''
      const stepLabel = `[Plan step ${index + 1} — ${this.labelOf(role)}]${marker}`
      const stepMessage: Message = {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${stepLabel}: ${step.description}\n\nResult:\n${trimmed}${fallbackNote}`
          }
        ]
      }
      yield { kind: 'message', role: 'user', content: stepMessage.content }
      conversation.push(stepMessage)

      // A step that cannot continue without the user makes every later step meaningless (they would
      // run on missing input). Stop the plan here; the final round below asks the user the question.
      if (d?.status === 'needs_input') break
    }

    yield* this.runLoop(
      this.buildOrchestratorSystemPrompt(),
      this.defaultTools,
      conversation,
      state,
      undefined,
      this.buildDelegateToolDefinitions(),
      true
    )
  }

  /** The label to show for a role: the agent's own (user-defined roles), else the manifest / legacy label, else a humanized id. */
  private labelOf(role: string): string {
    return this.agents.get(role)?.label ?? roleLabel(role)
  }

  /** Roles a plan may target — the agents' own `plannable` flag (user-defined roles), falling back to the built-in manifest. */
  private plannableRoleIds(): string[] {
    return [...this.agents.values()].filter((a) => a.plannable ?? (PLANNABLE_ROLES as readonly string[]).includes(a.role)).map((a) => a.role)
  }

  /**
   * Built from `this.agents`' own `summary` strings — the same source
   * `buildOrchestratorSystemPrompt` already uses — rather than a bare role
   * enum. Found live: given only role names, the classifier sometimes
   * assigned a lookup step to Planning (reasoning-only, no tools at all)
   * instead of Research, which actually has `search_history`/`web_search`.
   * The run self-corrected in the final synthesis round (which still has
   * every tool available), but a plan step should be routed to a role that
   * can actually do it.
   */
  private buildClassifySystemPrompt(): string {
    // Role facts are GENERATED (buildRoleDigest: each role's own summary + live
    // availability), not re-typed here as prose that drifts from the role. Only the
    // roles a plan may target (PLANNABLE_ROLES — the same set `parsePlan` accepts;
    // page-creator is deliberately not one) are listed. What remains below are
    // procedural rules, none of which name a specific role's tools.
    const specialists = buildRoleDigest(this.agents, this.plannableRoleIds(), this.options.getConfiguration?.())
    return (
      "Before anything else, classify the user's latest request and, only if it genuinely needs more " +
      'than one distinct sub-task, build a short ordered plan for it. You have no tools available for ' +
      'this — do not attempt to call one. Respond with ONLY a single JSON object, no markdown fence, ' +
      'no other text, and do not answer the request itself here:\n' +
      '{"complexity": "simple" | "compound", "steps": [{"role": "<one of the role ids below>", ' +
      '"description": "..."}]}\n' +
      '- "simple": answerable directly, or with at most one tool call or delegation. Use an empty steps ' +
      'array or a single entry.\n' +
      '- "compound": genuinely separate sub-tasks (e.g. two independent lookups, a lookup followed by ' +
      'a separate calculation, or gathering information and THEN saving/producing a deliverable from it) ' +
      "that each need a different specialist's tools. List each as its own ordered step, tagging the role " +
      "whose summary says it can actually do it — never route a step to a role its summary excludes, to a " +
      'role marked UNAVAILABLE, or to a role with no tools when the step needs a tool. Any part of the ' +
      'request that asks for a saved file/document/spreadsheet is its own step for the role that creates ' +
      'that kind of file, after the step(s) that gather what goes into it. If a sub-part needs no tool ' +
      "at all (pure reasoning, or combining results already gathered), don't give it its own step — it " +
      'belongs in the final answer instead.\n' +
      'A role whose summary says it writes AND runs code handles both in ONE step — never split writing ' +
      'a script from running it into separate steps or roles.\n' +
      // Found live (manual_testing.md section 4, Prompt B, 2026-10-01): the file/document rule above, applied
      // literally, split "generate the chart" (Developer) and "put it in a Word file" (Document Creator) into
      // two steps — but Document Creator cannot embed an image or chart at all and only ever bounces that
      // step back. Worse, with the document part framed as a separate step for someone else, step 2's own
      // wording asked Developer only for "the chart file paths" — never to save the document — so Developer
      // quietly over-delivered (embedding it anyway, unasked, because its own prompt nudges it to) while
      // Document Creator got invoked redundantly afterward for work already done.
      'A document/file that needs a chart or image generated from data AND embedded into it ("put these ' +
      'charts in a Word file") is ONE step for the role that writes and runs code — never split the chart ' +
      'generation from the document creation across two steps or two roles, and never route the document ' +
      "part to Document Creator for this: it cannot embed an image or chart at all and will only bounce the " +
      "step back. Word that one step's own description to cover BOTH halves explicitly — generate the " +
      'chart(s) AND save them into the requested document — so the result cannot silently omit the embedding ' +
      'or need a second, redundant pass to finish it. Only give Document Creator a step when the deliverable ' +
      'is genuinely text-only (headings, bullets, prose, or filling an existing template) with nothing to ' +
      'embed.\n' +
      'Domain knowledge (rules/constraints, or how to interpret something — from a wiki/MCP server, or the ' +
      'web if none is connected) together with the data those rules apply to (database/API) is always ' +
      'compound, one step per source, even in a single sentence and even without an explicit "look this up" ' +
      "cue — see needsDomainKnowledge below, which this must agree with. This is two DIFFERENT kinds of " +
      'source (rules vs. the data they apply to), not two sources for the same thing: never plan an MCP ' +
      'Operator step AND a Research/web step for one domain-knowledge question up front — found live, a ' +
      'pure definitional question with no database involved got both anyway, and web ran right after the ' +
      'wiki had already given a complete answer. Plan the wiki/MCP step alone; add web up front only if the ' +
      'user asked for it or for outside sources — an insufficient wiki result is handled after the fact ' +
      '(`no_information`/`incomplete`), not by planning both "just in case."\n' +
      "A later step only sees the written result of earlier steps: when a step needs data an earlier step " +
      'retrieves (query rows, figures, file contents), word the earlier step so it returns the actual ' +
      'values, not just a summary, and word the later step as working from those values — never from ' +
      'assumed or example data.\n' +
      'Building a slide deck/presentation is never a plan step for any role: it happens in the ' +
      "top-level's own final round, directly, via pptx_start_deck + delegate_to_page-creator per slide. If " +
      'the request needs research before the deck can be built, plan the research as its own step; leave ' +
      'the actual deck construction out of the plan entirely so it happens in that final round.\n' +
      "Keep the step count small and don't over-decompose a genuinely simple request into multiple " +
      `trivial steps just to look thorough.\n\nRoles:\n${specialists}`
    )
  }

  private buildOrchestratorSystemPrompt(): string {
    // No roster here: each specialist's summary is already carried once, in its delegate
    // tool's description (buildDelegateToolDefinitions), so repeating it in the system
    // prompt would just pay for the same text twice on every request.
    return (
      `${this.defaultSystemPrompt}\n\n` +
      "You can also delegate a step to a specialist by calling its delegate tool when the task clearly fits " +
      "one — each tool's description says what that specialist does and does not do. Anything that needs code " +
      'written AND run, or files created or changed, should usually go to the Developer rather than being ' +
      'handled directly. For simple or general requests, just answer directly (or use your own tools) ' +
      "without delegating. The workspace is shared across every session, so a file you find there (e.g. " +
      "via list_directory) may be real but may also predate this turn or belong to a different request. " +
      "Before telling the user a document/file/deliverable was created or updated, make sure that is " +
      "actually true of THIS turn — a step's own result text saying \"Files created or changed (verified " +
      "by the app, not self-reported)\" is real evidence; a file simply existing on disk is not. If a plan " +
      "step ended NEEDS INPUT, OUT OF SCOPE, or FAILED for the deliverable the user asked for, say plainly " +
      "that it was not produced — never present an old file from a previous turn as if it were this turn's " +
      "output. If you genuinely cannot tell whether something you see is new or pre-existing, say so and " +
      'ask the user rather than guessing. If any step ended PARTIAL INFORMATION, your final answer must ' +
      'say plainly what could and could not actually be confirmed — giving a confident-sounding answer ' +
      'built on an acknowledged information gap is worse than stating the gap outright; propose how to ' +
      'close it (what source/document/access would help) or ask the user for it, rather than quietly ' +
      'treating the partial result as if it fully answered the question. The user already saw each step reply: ' +
      'do not repeat their content in your final answer — say briefly what was done, where any file is, and ' +
      'what failed or needs attention.'
    )
  }

  /**
   * Forced-role mode (the composer's "Agent: X" mode picker pinned away
   * from "Auto") skips the orchestrator and its delegate tools entirely, so
   * a pinned specialist has no mechanism to hand off even when the request
   * clearly needs a different one. Found live: a session pinned to Research
   * was asked to save/convert a file, and — having no visibility into the
   * other specialists at all — replied "I'm the only agent running in this
   * conversation," which is only true because of the pin, not a real
   * capability gap. This notice gives the pinned specialist enough
   * awareness to name the right specialist and point the user back to the
   * mode picker, instead of claiming no other agents exist.
   */
  private buildForcedModeNotice(currentRole: AgentRole): string {
    const others = [...this.agents.values()]
      .filter((a) => a.role !== currentRole)
      .map((a) => `- ${this.labelOf(a.role)}: ${a.summary}`)
      .join('\n')
    return (
      '\n\n---\n' +
      `You are currently pinned to the ${this.labelOf(currentRole)} specialist only (the ` +
      'composer\'s "Agent:" selector, bottom-left, is set away from "Auto") — you cannot hand off to ' +
      'another specialist yourself right now, even when one clearly fits the request better, and you ' +
      "have no delegate tools available. If the user's request needs a capability outside your own " +
      "tools, don't say you have no other agents or no way to do it at all — name which specialist " +
      'would actually handle it from this list, and tell the user to switch the "Agent:" selector to ' +
      `"Auto" (so the orchestrator can delegate automatically) or directly to that specialist:\n${others}`
    )
  }

  /**
   * A real, honestly-scoped "what's happening" hint for the round about to
   * start — genuinely distinguishes the very first call of a run/specialist
   * (nothing to go on yet but the model itself) from a later round that's
   * actually reacting to a tool result, rather than a generic "Thinking…"
   * for both. Deliberately doesn't try to describe the model's own
   * reasoning content — no provider in this app streams that as a separate
   * signal, so anything more specific than "thinking" / "reviewing tool
   * results" would be a guess, not a real report.
   *
   * Includes the shared round budget (`state.roundsUsed`/MAX_TOTAL_ROUNDS)
   * — reported directly: with only a static "Thinking…" to look at, a long
   * multi-round turn (this app's own real round-cap investigation involved
   * exactly this) reads as stuck/unresponsive even while genuinely
   * progressing. A real "round 3/12" counter is honest, cheap progress
   * signal the renderer already has everything it needs to show.
   */
  private roundStatusMessage(agentRole: AgentRole | undefined, localRound: number, state: RunState, maxRounds: number): string {
    const activity = localRound === 1 ? 'thinking' : 'reviewing tool results'
    const progress = `(round ${state.roundsUsed}/${maxRounds})`
    return agentRole
      ? `${this.labelOf(agentRole)} agent is ${activity}… ${progress}`
      : `Model (${this.model}) is ${activity}… ${progress}`
  }

  private buildDelegateToolDefinitions(): ToolDefinition[] {
    return [...this.agents.values()].map((a) => buildDelegateToolDefinition(a.role, this.labelOf(a.role), a.summary))
  }

  /**
   * TASKS.md #102's "stopped, no answer" note — a top-level turn (or the
   * pre-round classify pass) that ends via a genuine user Stop with
   * literally nothing produced gets this instead of silently leaving
   * nothing persisted at all. Factored out since it's now emitted from 4
   * separate call sites: the classify-abort check in `run()`, the two
   * existing `runLoop` abort shapes, and the rate-limit wait's own abort
   * check below.
   */
  private *emitStoppedNoAnswer(agentRole: AgentRole | undefined): Generator<OrchestratorEvent> {
    const message = 'This request was stopped before producing a response. No answer was given.'
    yield { kind: 'stream', event: tagEvent({ type: 'warning', message, failureCategory: 'stopped_by_user' }, agentRole) }
    yield {
      kind: 'message',
      role: 'assistant',
      content: [{ type: 'warning', message, failureCategory: 'stopped_by_user' }]
    }
  }

  /**
   * TASKS.md #91 — a provider-confirmed rate limit (429), recognized
   * distinctly rather than surfacing as a generic stream error, gets its
   * own bounded wait-then-retry, with its own accounting
   * (`state.consecutiveRateLimitRetries`) deliberately separate from
   * `consecutiveRoundTimeouts`/`TURN_DEADLINE_MS` — the wait is real,
   * deliberate time this turn spends *because the provider asked it to*,
   * not evidence of a hung round, and must not be silently eaten by or
   * counted against the same wall-clock budget built for that entirely
   * different failure mode. `state.deadlineAt` is pushed forward by
   * whatever was actually waited (see the `+=` below) so the rest of the
   * turn still gets its full, real remaining time afterward.
   *
   * All 3 SDK families here (Anthropic, the shared OpenAI-compatible layer,
   * Google) already retry a 429 internally a couple of times before ever
   * throwing up to this method at all (see `rate-limit.ts`'s own doc
   * comment) — reaching here means that was already exhausted, so this is
   * deliberately a second, longer-patience layer on top, not a duplicate of
   * what the SDK already does.
   *
   * Throws (ending the turn, same as any other genuine failure — flows into
   * TASKS.md #102's `communication_failure` handling) once
   * `MAX_RATE_LIMIT_RETRIES` is exhausted, with a clear, specific message
   * rather than letting the last attempt's raw SDK error speak for itself.
   */
  private async *handleRateLimitError(
    err: unknown,
    state: RunState,
    agentRole: AgentRole | undefined,
    isTopLevel: boolean
  ): AsyncGenerator<OrchestratorEvent, 'retry' | 'stopped'> {
    if (state.consecutiveRateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
      throw new Error(
        `The provider says you've hit its rate limit, and it was still in effect after ${MAX_RATE_LIMIT_RETRIES} retries — try again in a few minutes.`
      )
    }
    state.consecutiveRateLimitRetries++
    const suggested = retryAfterMsFromError(err)
    const waitMs = Math.min(suggested ?? rateLimitBackoffMs(state.consecutiveRateLimitRetries), RATE_LIMIT_MAX_WAIT_MS)
    // "The provider says..." — mirrors #80's own lesson about honest
    // wording: this is the provider's own rate limit, not a bug in this app.
    const message =
      `The provider says you've hit its rate limit — waiting ${Math.round(waitMs / 1000)}s before retrying ` +
      `(attempt ${state.consecutiveRateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}).`
    yield { kind: 'stream', event: tagEvent({ type: 'warning', message }, agentRole) }

    const waited = await sleepAbortable(waitMs, this.signal)
    if (this.signal.aborted) {
      if (isTopLevel) yield* this.emitStoppedNoAnswer(agentRole)
      yield { kind: 'stream', event: tagMessageStop({ type: 'message_stop', stopReason: 'aborted' }, agentRole, isTopLevel) }
      return 'stopped'
    }
    state.deadlineAt += waited
    return 'retry'
  }

  /**
   * The shared round-loop: streams one provider turn, handles any resulting
   * tool calls (delegate or registry), and repeats until the model stops
   * calling tools or the shared round budget is exhausted. Used both for
   * the top-level call and, recursively via `yield*`, for every specialist's
   * own turn — which is what gives multi-hop chaining, per-round
   * confirmation, and the round cap "for free" at every nesting level.
   */
  private async *runLoop(
    systemPrompt: string,
    tools: Tool[],
    conversation: Message[],
    state: RunState,
    agentRole: AgentRole | undefined,
    extraToolDefs: ToolDefinition[] = [],
    isTopLevel = false,
    maxRounds: number = MAX_TOTAL_ROUNDS
  ): AsyncGenerator<OrchestratorEvent, { text: string; isError: boolean }> {
    const toolByName = new Map(tools.map((t) => [t.name, t]))
    const toolDefs: ToolDefinition[] = [
      ...toToolDefs(tools),
      ...extraToolDefs
    ]
    // Local to this runLoop call (unlike state.roundsUsed, which is the
    // shared safety cap across the whole run) — just distinguishes "first
    // call this specialist/the top level has made" from "continuing after
    // seeing a tool result," for the status message below.
    let localRound = 0
    // Empty-response recovery (local reasoning models sometimes end a round with no text and no tool call, typically right after a tool
    // result): re-ask up to MAX_EMPTY_RESPONSE_RETRIES times with a one-off nudge instead of ending the turn with nothing done.
    let emptyRetries = 0
    let nudgeAfterEmptyRound = false
    // TASKS.md #172/#173: bounded recovery for a round truncated mid-tool-call — see MAX_TRUNCATED_TOOL_CALL_RETRIES.
    let truncatedToolCallRetries = 0

    while (state.roundsUsed < maxRounds && Date.now() < state.deadlineAt) {
      state.roundsUsed++
      localRound++

      // TASKS.md #158: between-rounds checkpoint for a mid-run steering comment — top-level only (see the
      // drainSteeringComments option's own doc comment for why nested specialist rounds don't check this).
      // Non-blocking: nothing pending is the overwhelmingly common case, so this never delays a round.
      if (isTopLevel) {
        const steeringComments = this.options.drainSteeringComments?.() ?? []
        if (steeringComments.length > 0) {
          const noteText = steeringComments.join('\n')
          conversation.push({ role: 'user', content: [{ type: 'user_note', text: noteText }] })
          yield { kind: 'stream', event: { type: 'user_note', text: noteText } }
          yield { kind: 'message', role: 'user', content: [{ type: 'user_note', text: noteText }] }
        }
      }

      yield {
        kind: 'stream',
        event: tagEvent(
          { type: 'status', message: this.roundStatusMessage(agentRole, localRound, state, maxRounds) },
          agentRole
        )
      }

      let assistantText = ''
      // TASKS.md #147: separate from assistantText, same reasoning as why tool calls get their own array —
      // a provider's real thinking content is a genuinely different signal from its final answer text.
      let assistantThinking = ''
      const toolCalls: AccumulatedToolCall[] = []
      const toolCallsById = new Map<string, AccumulatedToolCall>()
      let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' = 'end_turn'
      // Some providers (Anthropic, Gemini) repeat a *cumulative* usage total
      // across several chunks within one round rather than sending it once —
      // confirmed live. Keep only the last one seen and report it as this
      // round's own contribution below, or every consumer downstream would
      // double/triple-count if they summed the raw events.
      let roundUsage: { inputTokens: number; outputTokens: number } | undefined

      // normalizeUserNotesForWire applied last, right before the wire — a user_note reads as ordinary text to
      // the model; every earlier step in this pipeline only needs to know about tool_result/tool_use shapes.
      let messagesToSend = normalizeUserNotesForWire(
        await this.refitConversationToBudget(
          capRepeatedToolResults(collapseDuplicateToolResults(conversation, toolByName), toolByName),
          toolByName,
          systemPrompt,
          toolDefs,
          state
        )
      )
      if (nudgeAfterEmptyRound) {
        messagesToSend = [...messagesToSend, { role: 'user', content: [{ type: 'text', text: EMPTY_RESPONSE_NUDGE }] }]
        nudgeAfterEmptyRound = false
      }
      let emptyRoundToRetry = false
      const roundTimer = this.startRoundTimer(state.deadlineAt, state.consecutiveRoundTimeouts)
      try {
        for await (const event of this.provider.stream({
          model: this.model,
          system: systemPrompt,
          messages: messagesToSend,
          maxTokens: state.maxOutputTokens,
          tools: toolDefs.length ? toolDefs : undefined,
          signal: roundTimer.signal,
          temperature: this.options.temperature
        })) {
          if (event.type === 'text_delta') {
            assistantText += event.text
          } else if (event.type === 'thinking_delta') {
            assistantThinking += event.text
          } else if (event.type === 'tool_use_start') {
            const call: AccumulatedToolCall = {
              id: event.id,
              name: event.name,
              inputJson: '',
              thoughtSignature: event.thoughtSignature
            }
            toolCalls.push(call)
            toolCallsById.set(event.id, call)
          } else if (event.type === 'tool_use_delta') {
            const call = toolCallsById.get(event.id)
            if (call) call.inputJson += event.partialInput
          } else if (event.type === 'message_stop') {
            stopReason = event.stopReason
            // An empty, cleanly-ended round we are about to retry: do not forward this end_turn, or the renderer would take it for the end
            // of the whole turn (a nested specialist's stop is tagged, the top level's is not). A genuine abort/timeout is not "empty".
            if (
              event.stopReason === 'end_turn' &&
              !assistantText &&
              toolCalls.length === 0 &&
              emptyRetries < MAX_EMPTY_RESPONSE_RETRIES &&
              !roundTimer.signal.aborted
            ) {
              emptyRoundToRetry = true
              continue
            }
          } else if (event.type === 'usage') {
            roundUsage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
            continue
          }
          const outEvent =
            event.type === 'message_stop' ? tagMessageStop(event, agentRole, isTopLevel) : tagEvent(event, agentRole)
          yield { kind: 'stream', event: outEvent }
        }
      } catch (err) {
        // TASKS.md #91 — checked before anything else in this block: a
        // provider-confirmed rate limit (429) is a genuine thrown error
        // (roundTimer.signal.aborted is normally false for it — the
        // underlying HTTP call actually completed, our own signal didn't
        // fire), so it must be intercepted here, before the "not our own
        // abort, rethrow unchanged" check right below would otherwise
        // immediately rethrow it as a generic failure.
        if (isRateLimitError(err)) {
          const outcome = yield* this.handleRateLimitError(err, state, agentRole, isTopLevel)
          if (outcome === 'stopped') return { text: assistantText, isError: true }
          continue // 'retry' — same round, from the top of the while loop (roundTimer.clear() in `finally` below still runs first)
        }
        // The signal is the source of truth for "was this a user-requested
        // stop" — every provider SDK throws its own differently-shaped abort
        // error, and pattern-matching on error names/types across all 4
        // would be brittle. A genuine failure (network error, bad request,
        // etc.) rethrows unchanged, preserving today's error surfacing.
        // roundTimer.signal (not this.signal) is checked here specifically
        // so a round-timeout — this round alone taking past its own budget
        // — is recognized as a clean abort too, not rethrown as a genuine
        // error.
        if (!roundTimer.signal.aborted) throw err
        if (!roundTimer.timedOut()) {
          // A real user Stop click — ends the whole turn now, as before.
          // TASKS.md #102: when it produced literally nothing AND this is
          // the top-level turn ending here, persist an explicit "stopped by
          // the user, no answer" note — previously this case left nothing
          // persisted at all (not even a warning), so the same question
          // just kept getting silently resent as unanswered "real" context
          // on every later call.
          if (isTopLevel && !assistantText && toolCalls.length === 0) yield* this.emitStoppedNoAnswer(agentRole)
          yield { kind: 'stream', event: tagMessageStop({ type: 'message_stop', stopReason: 'aborted' }, agentRole, isTopLevel) }
          return { text: assistantText, isError: true }
        }
        // A genuine round-timeout that the provider surfaced as a thrown
        // error — fall through to the shared roundTimer.timedOut() handling
        // below, the same as the silent-completion shape.
      } finally {
        roundTimer.clear()
      }

      /**
       * A round-timeout can surface in two completely different shapes for
       * the exact same underlying cause (this round's own timer fired and
       * called `controller.abort()`), depending on how the provider's SDK
       * reacts to an aborted request:
       *  1. It rejects the in-flight promise/iterator (Anthropic's and
       *     Google's SDKs, confirmed live) — caught above, handled in the
       *     `catch` block.
       *  2. It doesn't throw at all (the `openai` SDK — used for both
       *     OpenAI itself and Ollama's OpenAI-compat endpoint — confirmed
       *     live and by direct reproduction: aborting a stalled stream ends
       *     its async iterator cleanly, no exception). `streamOpenAICompatible`
       *     then hits its own end-of-stream fallback and yields an ordinary-
       *     looking empty `end_turn`, which used to be silently misread as
       *     "the model produced no output" — ending the whole round/turn
       *     with a warning that blamed "a known quirk with local reasoning
       *     models," instead of retrying with more time. `provider.requests`
       *     stayed at 1 for the entire remaining turn budget in a real
       *     reproduction of this — the retry path was never reached at all.
       * Checking `roundTimer.timedOut()` directly here — after the try/catch
       * either fell through or was caught above — is what makes the retry
       * fire for shape 2 as well as shape 1.
       */
      if (this.signal.aborted && !roundTimer.timedOut() && !assistantText && toolCalls.length === 0) {
        // A genuine user Stop, surfaced via shape 2 above (no thrown error)
        // — same "the user asked for this, not a timeout" outcome the catch
        // block already gives shape 1, just reached without an exception to
        // catch. Narrowed to "no real content produced" so a round that
        // actually finished at the same instant Stop happened to be clicked
        // still gets to keep its real answer instead of being discarded.
        // TASKS.md #102: same top-level-only "stopped, no answer" note as
        // the catch-based shape 1 above — this condition already implies
        // both `isTopLevel` doesn't need re-checking for content emptiness.
        if (isTopLevel) yield* this.emitStoppedNoAnswer(agentRole)
        yield {
          kind: 'stream',
          event: tagMessageStop({ type: 'message_stop', stopReason: 'aborted' }, agentRole, isTopLevel)
        }
        return { text: assistantText, isError: true }
      }

      if (roundTimer.timedOut()) {
        // A round-timeout is NOT a user Stop — ending the whole turn over
        // one slow round would be exactly as bad as the bug this exists to
        // fix (one stuck slide killing an otherwise-fine presentation).
        // Report it and let the loop continue to the next round instead —
        // still bounded by the normal maxRounds/state.deadlineAt checks
        // above, same as any other round. Growing the budget here (rather
        // than resetting to 0) is what the next startRoundTimer call reads
        // to give the retry more room than this attempt got.
        state.consecutiveRoundTimeouts++
        const message =
          `The model hasn't finished responding after over ${Math.round(roundTimer.budgetMs / 60000)} ` +
          "minute(s) — this is generation time on a slow model, not a tool being stuck. Giving it more " +
          'time and trying again.'
        yield { kind: 'stream', event: tagEvent({ type: 'warning', message }, agentRole) }
        continue
      }

      // The round actually completed (whether or not it timed out, or hit a
      // rate limit, on a *previous* attempt) — the next round starts a
      // fresh escalation from here, not compounding on unrelated future
      // slowness/rate-limiting.
      state.consecutiveRoundTimeouts = 0
      state.consecutiveRateLimitRetries = 0

      if (roundUsage) {
        state.inputTokens += roundUsage.inputTokens
        state.outputTokens += roundUsage.outputTokens
        yield { kind: 'stream', event: { type: 'usage', ...roundUsage } }
      }

      if (emptyRoundToRetry) {
        emptyRetries++
        nudgeAfterEmptyRound = true
        yield {
          kind: 'stream',
          event: tagEvent(
            { type: 'status', message: 'The model returned an empty response — asking it to continue…' },
            agentRole
          )
        }
        continue
      }

      const assistantBlocks: ContentBlock[] = []
      // TASKS.md #147: pushed before the text block — reasoning precedes the final answer, both
      // conceptually and in how it should render.
      if (assistantThinking) assistantBlocks.push({ type: 'thinking', text: assistantThinking, agentRole })
      if (assistantText) assistantBlocks.push({ type: 'text', text: assistantText, agentRole })
      if (stopReason === 'max_tokens') {
        // Found live against gpt-oss (empty response) before this existed —
        // don't silently treat a truncated round as a normal, complete one.
        // Whatever text/tool calls DID make it through above are kept, not
        // discarded; this just tells the user/caller the round was cut off
        // before it necessarily finished.
        const message = `This response was cut off after reaching the ${state.maxOutputTokens}-token output limit for this round — it may be incomplete.`
        // Only a whole-turn failure (TASKS.md #102) when there's no partial
        // text either AND this is the top-level turn ending here (this
        // branch always returns immediately below — see the `stopReason !==
        // 'tool_use'` check) — a cut-off response that still has real
        // partial content, or a nested specialist's own truncated round
        // (the outer turn can still produce a real final answer afterward),
        // both stay ordinary, kept-in-context warnings.
        const failureCategory = isTopLevel && !assistantText ? 'no_answer' : undefined
        assistantBlocks.push({ type: 'warning', message, agentRole, failureCategory })
        yield { kind: 'stream', event: tagEvent({ type: 'warning', message, failureCategory }, agentRole) }
      } else if (!assistantText && toolCalls.length === 0) {
        // A second, distinct empty-response shape from the max_tokens one
        // above — found live against gpt-oss/Ollama on a long, tool-heavy
        // conversation: the server's own stream ended cleanly
        // (finish_reason "stop", not "length" — the output budget was never
        // exhausted) yet produced no visible content and no tool call at
        // all. Ollama surfaces gpt-oss's chain-of-thought as a separate
        // `reasoning` delta field this app deliberately never reads (see
        // streamOpenAICompatible) — confirmed live that the model can spend
        // an entire round reasoning and then just stop, past reasoning
        // grown long enough. Previously this ended the turn in total
        // silence: no persisted message, no visible error, nothing —
        // indistinguishable from the app having done nothing at all.
        const message =
          'The model produced no visible output for this response (no text, no tool call) — a known quirk ' +
          'with local reasoning models on longer or more complex requests. Try asking again.'
        // Always a whole-turn failure when it's the top level (this branch
        // always returns immediately below, same reasoning as max_tokens
        // above) — TASKS.md #102.
        const failureCategory = isTopLevel ? 'no_answer' : undefined
        assistantBlocks.push({ type: 'warning', message, agentRole, failureCategory })
        yield { kind: 'stream', event: tagEvent({ type: 'warning', message, failureCategory }, agentRole) }
      }
      const inputByCallId = new Map<string, Record<string, unknown>>()
      // design-discussion.md §13.3, TASKS #146: the same MCP-availability substitution #145 applies to a
      // *plan* step, applied here to a direct `delegate_to_mcp-operator` tool call the top-level model
      // makes on its own (the more common shape for a plain "look this up in the wiki" request, which
      // never goes through executePlan at all). Rewritten BEFORE the `tool_use` block is built, not after
      // dispatch, so the persisted name and the specialist that actually ran always agree — the opposite
      // order would leave a `delegate_to_mcp-operator` tool_use in the transcript next to a Researcher's
      // result, which would misattribute the work in the UI and on replay.
      const delegateRoleOverride = new Map<string, AgentRole>()
      for (const call of toolCalls) {
        let input: Record<string, unknown> = {}
        try {
          input = call.inputJson ? JSON.parse(call.inputJson) : {}
        } catch {
          // Malformed tool input is surfaced back to the model as an error result below.
        }
        let name = call.name
        const requestedRole = roleFromDelegateName(name, this.agents)
        if (requestedRole && typeof input.task === 'string') {
          const substituted = this.substituteUnavailableMcpOperator(requestedRole, input.task)
          if (substituted.role !== requestedRole) {
            name = delegateToolName(substituted.role)
            input = { ...input, task: substituted.description }
            delegateRoleOverride.set(call.id, substituted.role)
          }
        }
        inputByCallId.set(call.id, input)
        assistantBlocks.push({
          type: 'tool_use',
          id: call.id,
          name,
          input,
          agentRole,
          thoughtSignature: call.thoughtSignature
        })
      }
      // Snapshot before appending this round's assistant blocks: a delegate call's
      // nested conversation must NOT include the orchestrator's own (not-yet-resolved)
      // delegate_to_x tool_use as its last message — OpenAI's API rejects an assistant
      // message with tool_calls that isn't immediately followed by matching tool
      // responses, and the specialist doesn't need to see that internal routing call
      // anyway. (Found live: a real 400 from OpenAI on the first delegation attempt.)
      const conversationBeforeThisRound = [...conversation]

      if (assistantBlocks.length) yield { kind: 'message', role: 'assistant', content: assistantBlocks }
      conversation.push({ role: 'assistant', content: assistantBlocks })

      if (stopReason === 'max_tokens' && toolCalls.length > 0 && truncatedToolCallRetries < MAX_TRUNCATED_TOOL_CALL_RETRIES) {
        // Every dangling tool_use just pushed above still needs a matching tool_result (an unresolved
        // tool_call followed by anything else is rejected by at least one real provider — see the
        // conversationBeforeThisRound comment below for the identical reasoning) — so each gets a real,
        // actionable error instead of being executed with whatever garbage input survived truncation,
        // and the round retries once with that explanation already in context.
        truncatedToolCallRetries++
        const truncatedResultBlocks: ContentBlock[] = toolCalls.map((call) => ({
          type: 'tool_result',
          toolUseId: call.id,
          content:
            "This call's arguments were cut off by the output-length limit before they finished, so it " +
            'was not run. Produce a SHORTER response this time — if you are working with captured data, ' +
            'read it from its file (open/json.load) instead of embedding it — then try again.',
          isError: true
        }))
        for (const block of truncatedResultBlocks) {
          if (block.type === 'tool_result') {
            yield { kind: 'stream', event: { type: 'tool_result', toolUseId: block.toolUseId, content: block.content, isError: block.isError } }
          }
        }
        yield { kind: 'message', role: 'user', content: truncatedResultBlocks }
        conversation.push({ role: 'user', content: truncatedResultBlocks })
        continue
      }

      if (stopReason !== 'tool_use' || toolCalls.length === 0) {
        return { text: assistantText, isError: stopReason === 'max_tokens' || !assistantText }
      }

      const resultBlocks: ContentBlock[] = []
      for (const call of toolCalls) {
        const input = inputByCallId.get(call.id) ?? {}
        const delegateRole = delegateRoleOverride.get(call.id) ?? roleFromDelegateName(call.name, this.agents)

        let content: string
        let isError: boolean
        if (delegateRole) {
          const outcome = yield* this.dispatchDelegate(delegateRole, input, conversationBeforeThisRound, state)
          content = outcome.content
          isError = outcome.isError
        } else {
          const result = await this.dispatchTool(call.id, call.name, input, toolByName)
          if (toolByName.has(call.name)) this.options.logToolUse?.({ tool: call.name, agentRole: agentRole ?? 'router' })
          content = result.content
          isError = result.isError
          // TASKS.md #82 — a real `image` block, never sent back to the
          // model (see ContentBlock's own doc comment), alongside the
          // short tool_result text above that the model does see.
          if (result.image) {
            const imageBlock: ContentBlock = { type: 'image', toolUseId: call.id, ...result.image, agentRole }
            resultBlocks.push(imageBlock)
            yield { kind: 'stream', event: tagEvent({ type: 'image', toolUseId: call.id, ...result.image }, agentRole) }
          }
        }

        resultBlocks.push({ type: 'tool_result', toolUseId: call.id, content, isError })
        yield { kind: 'stream', event: { type: 'tool_result', toolUseId: call.id, content, isError } }
      }
      yield { kind: 'message', role: 'user', content: resultBlocks }
      conversation.push({ role: 'user', content: resultBlocks })
    }

    const outOfTime = Date.now() >= state.deadlineAt

    // Ask before abandoning, rather than always silently wrapping up — a
    // no-op (askToContinue immediately resolves continueWorking: false)
    // unless the caller opted in via options.confirmContinue, so every
    // existing caller/test keeps today's exact unchanged behavior. Granting
    // more budget just resets the counters and re-enters this same method
    // via yield* — a fresh call, not a special retry path, so it goes
    // through the exact same round loop (and can hit this exact same
    // question again if it also runs out).
    const continueDecision = await this.askToContinue({
      requestId: randomUUID(),
      reason: outOfTime ? 'time' : 'rounds',
      roundsUsed: state.roundsUsed,
      maxRounds,
      agentRole
    })
    if (continueDecision.continueWorking) {
      state.roundsUsed = 0
      if (outOfTime) state.deadlineAt = Date.now() + TURN_DEADLINE_MS
      return yield* this.runLoop(systemPrompt, tools, conversation, state, agentRole, extraToolDefs, isTopLevel, maxRounds)
    }

    // Round budget exhausted (and either no confirmContinue was configured,
    // or the user chose to stop rather than continue) — rather than
    // discarding everything gathered so far and returning a bare "ran out
    // of rounds" stub, make one final, tools-disabled call asking the model
    // to synthesize a real answer from what's already in `conversation`.
    // Found live, and worse than it first looked: `state.roundsUsed` used
    // to be shared across the *entire* run, not scoped per delegate call —
    // so once a nested plan-step delegate exhausted the budget,
    // executePlan's own top-level synthesis call (whose whole job is
    // weaving plan-step results into a real final answer) hit the identical
    // exhausted counter and fell through to this same stub too,
    // immediately, without running a single round (fixed separately — see
    // dispatchDelegate's own fresh-budget-per-call comment). The user's
    // real question had already turned up a genuinely relevant, on-topic
    // result (a real news article) sitting untouched in `conversation` when
    // this used to just discard it all. This wrap-up call runs
    // unconditionally here regardless of how far over budget
    // `state.roundsUsed` already is — every call site that hits this path
    // gets exactly one real chance to summarize instead of stub out.
    let wrapUpText = ''
    const wrapUpSystem =
      `${systemPrompt}\n\n${
        outOfTime
          ? "You have used all the time available for this turn — it's taking too long — no"
          : `You have used all ${maxRounds} rounds available for this turn — no`
      } ` +
      'more tool calls are possible. Answer now using only what has already been found above: ' +
      "summarize the real information gathered so far, and say plainly if it's incomplete, rather " +
      'than attempting anything further.'
    // The wrap-up call is exactly the scenario #98 (see refitConversationToBudget) exists for —
    // reached after exhausting rounds/a whole plan, so `conversation` is at its largest for the turn.
    const wrapUpMessages = normalizeUserNotesForWire(
      await this.refitConversationToBudget(
        capRepeatedToolResults(collapseDuplicateToolResults(conversation, toolByName), toolByName),
        toolByName,
        wrapUpSystem,
        [],
        state
      )
    )
    // A one-shot call with no retry of its own, so no escalation applies — same as classifyAndPlan.
    const wrapUpTimer = this.startRoundTimer(state.deadlineAt, 0)
    try {
      for await (const event of this.provider.stream({
        model: this.model,
        system: wrapUpSystem,
        messages: wrapUpMessages,
        maxTokens: state.maxOutputTokens,
        signal: wrapUpTimer.signal,
        temperature: this.options.temperature
        // No `tools` — forces a text-only reply, so this genuinely cannot loop further.
      })) {
        if (event.type === 'text_delta') wrapUpText += event.text
        if (event.type === 'usage') {
          state.inputTokens += event.inputTokens
          state.outputTokens += event.outputTokens
        }
        // Every event forwarded the same way the main loop above does,
        // message_stop included — found live in review, not yet in
        // production: an earlier draft of this wrap-up only forwarded
        // text_delta/usage, silently dropping message_stop. The renderer's
        // "is this turn actually finished" detection depends on seeing a
        // real (correctly tagged) message_stop; without one, this fix
        // would have traded a visible-but-unhelpful stub for a genuinely
        // stuck-looking composer — the exact symptom being fixed.
        const outEvent =
          event.type === 'message_stop' ? tagMessageStop(event, agentRole, isTopLevel) : tagEvent(event, agentRole)
        yield { kind: 'stream', event: outEvent }
      }
    } catch (err) {
      if (!wrapUpTimer.signal.aborted) throw err
      return { text: wrapUpText, isError: true }
    } finally {
      wrapUpTimer.clear()
    }

    if (wrapUpText) {
      yield { kind: 'message', role: 'assistant', content: [{ type: 'text', text: wrapUpText, agentRole }] }
      return { text: wrapUpText, isError: false }
    }

    return {
      text: outOfTime ? 'Stopped — this turn was taking too long.' : `Stopped after ${maxRounds} agent rounds.`,
      isError: true
    }
  }

  /**
   * `this.confirmTool` only ever resolves via the renderer's Approve/Deny
   * click (see `makeConfirmTool` in ipc/register.ts) — it has no idea the
   * signal exists. Found live: clicking Stop while a confirmation dialog is
   * open did nothing, because `dispatchTool` was awaiting that bare promise
   * with no path back to the round loop's own abort handling. Racing it
   * against the signal here treats "stop while waiting on you" the same as
   * a denial, which lets this round finish immediately; the *next*
   * `provider.stream()` call then hits the loop's existing `signal.aborted`
   * check and ends the run with the normal "aborted" message_stop, so no
   * separate abort-specific stop reason is needed here.
   */
  private confirmOrAbort(request: ToolConfirmRequest): Promise<ConfirmDecision> {
    if (this.signal.aborted) return Promise.resolve({ approved: false })
    return new Promise((resolve) => {
      const onAbort = (): void => resolve({ approved: false })
      this.signal.addEventListener('abort', onAbort, { once: true })
      this.confirmTool(request).then((decision) => {
        this.signal.removeEventListener('abort', onAbort)
        resolve(decision)
      })
    })
  }

  /**
   * Same abort-race shape as `confirmOrAbort` above, for the same reason —
   * a genuine Stop click while this is pending must resolve it immediately
   * rather than leaving it to the renderer's round trip. Also the single
   * place that applies today's exact unchanged default (no configured
   * `confirmContinue` — the common case for every caller that hasn't opted
   * in, including every existing test) by resolving `continueWorking: false`
   * without ever reaching the renderer at all.
   */
  private askToContinue(request: LimitReachedRequest): Promise<LimitDecision> {
    const confirmContinue = this.options.confirmContinue
    if (!confirmContinue || this.signal.aborted) return Promise.resolve({ continueWorking: false })
    return new Promise((resolve) => {
      const onAbort = (): void => resolve({ continueWorking: false })
      this.signal.addEventListener('abort', onAbort, { once: true })
      confirmContinue(request).then((decision) => {
        this.signal.removeEventListener('abort', onAbort)
        resolve(decision)
      })
    })
  }

  /** A specialist's own tool calls (e.g. Coding calling write_file) still go through normal confirmation. */
  /** The first specialist whose tool list contains `name`, or undefined — used to turn "Unknown tool" into "that tool belongs to <role>". */
  private roleOwningTool(name: string): AgentRole | undefined {
    for (const agent of this.agents.values()) if (agent.tools.some((t) => t.name === name)) return agent.role
    return undefined
  }

  private async dispatchTool(
    toolUseId: string,
    name: string,
    input: Record<string, unknown>,
    toolByName: Map<string, Tool>
  ): Promise<{ content: string; isError: boolean; image?: { path: string; mimeType: string; dataBase64: string } }> {
    const tool = toolByName.get(name)
    if (!tool) {
      // A tool that exists but belongs to a specialist (the router no longer carries every tool, and a
      // replayed history may contain calls to tools it doesn't have) gets a redirect, not a dead end.
      const owner = this.roleOwningTool(name)
      return {
        content: owner
          ? `Tool "${name}" is not available here — it belongs to the ${this.labelOf(owner)} specialist. Call delegate_to_${owner.replace(/-/g, '_')} with the task instead.`
          : `Unknown tool "${name}".`,
        isError: true
      }
    }

    const mutates = typeof tool.mutates === 'function' ? tool.mutates(input) : tool.mutates
    if (mutates) {
      const decision = await this.confirmOrAbort({
        toolUseId,
        name: tool.name,
        input,
        description: tool.describe?.(input) ?? JSON.stringify(input),
        secretFields: tool.secretFields,
        hasValidation: tool.validate !== undefined
      })
      if (!decision.approved) {
        // Bracket convention matches the other whole-turn-failure qualifiers
        // (TASKS.md #102) for consistency — this one was already reaching
        // the model correctly before (a tool_result, unlike a `warning`
        // block, was never stripped from the wire format), so no other
        // change needed here.
        return { content: '[Rejected by user] The user denied this tool call.', isError: true }
      }
      input = decision.input ?? input
    }

    try {
      const content = await this.executeWithTimeout(tool, input)
      if (name === 'show_media') {
        // TASKS.md #82 — show_media signals its real image payload via a
        // JSON marker (see tools/show-media.ts) rather than widening the
        // `Tool.execute(): Promise<string>` contract every other tool
        // implements, just for this one. Split here into a real `image`
        // block (never sent back to the model — see ContentBlock's own doc
        // comment) plus a short, honest tool_result text the model does see.
        try {
          const parsed = JSON.parse(content) as Partial<ShowMediaPayload>
          if (parsed[SHOW_MEDIA_MARKER] && parsed.path && parsed.mimeType && parsed.dataBase64) {
            return {
              content: `Displayed ${parsed.path} to the user.`,
              isError: false,
              image: { path: parsed.path, mimeType: parsed.mimeType, dataBase64: parsed.dataBase64 }
            }
          }
        } catch {
          // Malformed marker payload — fall through and surface the raw
          // content as an ordinary (unusual, but not fatal) tool result.
        }
      }
      return { content, isError: false }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true }
    }
  }

  /**
   * Races `tool.execute` against `this.signal` (Stop) and a flat timeout, so
   * neither can leave the turn waiting forever — see `TOOL_EXECUTE_TIMEOUT_MS`.
   * A loser's rejection is what's thrown. Also builds a dedicated
   * `AbortController` (aborted from either source) and passes its signal
   * into `tool.execute` — flagged by an external code review (`review.md`,
   * TASKS.md #93): the orchestrator's own *wait* was already bounded, but
   * the tool itself never had any way to know it should stop, so a mutating
   * tool (shell command, file write, DB mutation) kept running after Stop or
   * a timeout regardless. A tool that doesn't read `signal` at all (most of
   * them — no cancellable operation to speak of) is unaffected: this is
   * additive, not a behavior change for tools that ignore it, and the
   * message reflects the difference (`tool.cancellable` — see
   * `shellExecuteTool` — vs. every other tool, which honestly says the
   * underlying operation may still be running).
   */
  private executeWithTimeout(tool: Tool, input: Record<string, unknown>): Promise<string> {
    if (this.signal.aborted) return Promise.reject(new Error('The user stopped this turn.'))
    const controller = new AbortController()
    return new Promise((resolve, reject) => {
      let settled = false
      const onAbort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        controller.abort()
        reject(new Error('The user stopped this turn.'))
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        controller.abort()
        const outcome = tool.cancellable
          ? 'cancelling it so the turn can continue.'
          : 'giving up on this tool call so the turn can continue — it has no way to be cancelled, so the ' +
            'underlying operation may still be running in the background.'
        reject(
          new Error(`"${tool.name}" did not finish within ${Math.round(TOOL_EXECUTE_TIMEOUT_MS / 60000)} minute(s) — ${outcome}`)
        )
      }, TOOL_EXECUTE_TIMEOUT_MS)
      const cleanup = (): void => {
        clearTimeout(timer)
        this.signal.removeEventListener('abort', onAbort)
      }
      this.signal.addEventListener('abort', onAbort, { once: true })
      tool.execute(input, this.toolContext, controller.signal).then(
        (content) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(content)
        },
        (err) => {
          if (settled) return
          settled = true
          cleanup()
          reject(err)
        }
      )
    })
  }

  /**
   * Recursively runs the chosen specialist's own loop, forwarding every
   * intermediate event via `yield*` so the caller sees it live, then wraps
   * the specialist's final answer as this delegate call's tool_result.
   * Errors from the nested loop (e.g. a provider/network failure) are
   * contained here — turned into an isError result for just this one
   * delegate call — rather than propagating up and killing the whole turn.
   */
  private async *dispatchDelegate(
    role: AgentRole,
    input: Record<string, unknown>,
    conversation: Message[],
    state: RunState,
    planContext?: { index: number; total: number }
  ): AsyncGenerator<OrchestratorEvent, DelegateOutcome> {
    const agent = this.agents.get(role)
    if (!agent) return { content: `Unknown agent role "${role}".`, isError: true }

    const task = String(input.task ?? '')
    // Found live: given a plan step that was squarely within its own tools (a database query), a
    // specialist instead looked at the whole non-isolated parent conversation — which also named a
    // later step's own work ("...then put it in a Word document") — and called its OWN step out of
    // scope, never attempting the query at all. The step's `[handoff: out_of_scope -> ...]` then named
    // a role id ("document-generation") that doesn't exist, so even the redirect safety net below
    // couldn't recover it. This note is deliberately only added for a plan-dispatched step (not every
    // delegate call) — it is the "other steps belong elsewhere, that's not your problem" framing a plan
    // step specifically needs that an ordinary single delegation doesn't.
    const planScopeNote = planContext
      ? `\n\n(This is step ${planContext.index + 1} of ${planContext.total} in a multi-step plan for the user's original request — the other step(s) are being handled by other specialists in this same turn, not by you. Do only THIS step, with your own tools. A part of the original request that belongs to a different step is not a reason to call THIS step out of scope — only call [handoff: out_of_scope -> <role-id>] if THIS step's own task genuinely needs a tool/capability you don't have. If you do, name a real role id, one of: ${this.plannableRoleIds().join(', ')}. The user sees each step's reply as it is written, so keep yours short: give figures or content only if this step is the one that produced them — never repeat what an earlier step already showed or what you just wrote into a file; name the file instead.)`
      : ''
    // The real outputs of earlier delegates this turn (files they produced, data they retrieved) are
    // appended to the brief by the app — typed inputs, not something the router has to remember to pass.
    const taskMessage: Message = {
      role: 'user',
      content: [{ type: 'text', text: `[Orchestrator -> ${this.labelOf(role)}]: ${task}${formatInputs(state.handoff.items)}${planScopeNote}` }]
    }
    // `isolated` (#77) controls conversation scoping only — this brief alone
    // vs. the whole parent conversation. The round *budget* is always its
    // own fresh pool per delegate call, isolated or not — found live: one
    // shared MAX_TOTAL_ROUNDS pool across the whole turn let a single
    // delegate's real, legitimate work (several file reads, then a
    // multi-step Docker build/debug/fix cycle — nothing looping or wasted)
    // exhaust the budget the rest of the turn still needed, cutting the
    // task off mid-way with the container not yet confirmed working. Every
    // delegate call now gets the same clean slate a role invoked repeatedly
    // per turn (once per slide, say) already relied on for #77, and a
    // compound plan's steps can no longer starve each other or the final
    // synthesis round.
    const nestedConversation: Message[] = agent.isolated ? [taskMessage] : [...conversation, taskMessage]
    const nestedState: RunState = {
      roundsUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      maxOutputTokens: state.maxOutputTokens,
      // Not reset — the fresh round *count* is per-delegate-call, but the
      // wall-clock turn deadline is the whole turn's, shared with every
      // other delegate call in it.
      deadlineAt: state.deadlineAt,
      consecutiveRoundTimeouts: 0,
      consecutiveRateLimitRetries: 0,
      handoff: state.handoff
    }
    const maxRounds = agent.maxRounds ?? MAX_TOTAL_ROUNDS

    // Artifacts are derived, not claimed: diff the workspace around the run. Skipped for isolated
    // single-purpose roles (slides, email) and roles with no tools, where there is nothing to find.
    const root = this.toolContext.workspaceGuard?.root
    const trackFiles = Boolean(root) && !agent.isolated && agent.tools.length > 0
    const before = trackFiles ? await snapshotWorkspace(root as string) : undefined

    const toolNames = new Map<string, string>()
    const dataFiles: HandoffDataFile[] = []

    try {
      // Driven by hand (not `yield*`) so the nested run's tool results can be observed and the
      // data-producing ones saved for later steps, while every event still reaches the caller unchanged.
      const gen = this.runLoop(agent.systemPrompt, agent.tools, nestedConversation, nestedState, role, [], false, maxRounds)
      let next = await gen.next()
      while (!next.done) {
        const event = next.value
        if (event.kind === 'stream') {
          const e = event.event
          if (e.type === 'tool_use_start') toolNames.set(e.id, e.name)
          else if (e.type === 'tool_result' && !e.isError && root && dataFiles.length < MAX_DATA_FILES_PER_DELEGATE) {
            const name = toolNames.get(e.toolUseId)
            if (name && isCapturableDataTool(name)) {
              const saved = await saveHandoffData(root, state.handoff.turnId, ++state.handoff.seq, name, e.content)
              if (saved) dataFiles.push(saved)
            }
          }
        }
        yield event
        next = await gen.next()
      }
      const loopResult = next.value
      // The round ceiling is its own fresh pool per delegate call, but real
      // token cost never is — roll up into the parent's cumulative totals
      // so session_usage/the context meter still see the true full cost.
      state.inputTokens += nestedState.inputTokens
      state.outputTokens += nestedState.outputTokens

      const tag = parseHandoffTag(loopResult.text || '')
      const diff = before && root ? diffSnapshots(before, await snapshotWorkspace(root)) : undefined
      const artifacts = diff ? [...diff.created, ...diff.modified] : []
      // status: code decides failure; the model only ever chooses the two judgment cases, and only on a clean end.
      const rawStatus = loopResult.isError ? 'failed' : (tag.status ?? 'done')
      // Found live: Data Access queried successfully, wrote a complete, correct answer from real data —
      // then appended `[handoff: out_of_scope -> document-creator]` anyway. `out_of_scope` means "I lack
      // the capability for this"; dataFiles/artifacts are proof of real tool use that already produced
      // real output, which directly contradicts that. The redirect-once safety net trusted the tag at
      // face value, triggering a wasted specialist call whose output the step after it then discarded
      // entirely. A contradictory tag is a model slip, not a real capability boundary — override to
      // `done` rather than redirect. Left untouched for `needs_input` (legitimately compatible with
      // partial work) and `no_information` (self-consistent: it implies nothing was captured anyway).
      const overridden = rawStatus === 'out_of_scope' && (dataFiles.length > 0 || artifacts.length > 0)
      const status = overridden ? 'done' : rawStatus
      const result: DelegateResult = {
        role,
        status,
        summary: tag.text || (tag.detail ?? '') || '(no response)',
        artifacts,
        dataFiles,
        blocker: overridden ? undefined : tag.detail,
        suggestedRole: overridden ? undefined : tag.suggestedRole,
        isError: status === 'failed'
      }
      for (const d of dataFiles) state.handoff.items.push({ fromRole: role, kind: 'data', path: d.path, note: `${d.tool}: ${d.summary}` })
      for (const p of artifacts.slice(0, 30)) state.handoff.items.push({ fromRole: role, kind: 'file', path: p, note: 'created or changed by this step' })
      return { content: formatDelegateResult(result), isError: result.isError, result }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true }
    }
  }
}
