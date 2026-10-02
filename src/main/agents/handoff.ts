import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentRole } from '@shared/agents'

/**
 * The typed handoff between the router and a specialist (design-discussion.md 5.1).
 *
 * Found live twice (Appendix D1/D2): a Data step queried 30 real rows, but a later
 * Coding step only ever saw the Data step's prose summary — so it wrote "Sample data
 * structure assumed" and charted invented customers for years the database does not
 * contain — and the run ended with a cheerful "task completed" over a Word file with
 * no charts. Prose is a lossy channel between specialists, and what a specialist
 * *says* it produced is not evidence. So the contract is enforced in code:
 *
 *  - **`artifacts` are derived, not claimed:** the files a delegate actually created or
 *    changed are found by diffing the workspace before and after its run
 *    (`snapshotWorkspace` / `diffSnapshots`) — this catches what a shell or Python
 *    script wrote, which no per-tool bookkeeping could.
 *  - **Data travels by file:** the full result of a data-producing tool call
 *    (`db_execute_sql`, `parse_csv`, ...) is saved to a workspace file and its path is
 *    handed to later steps, so a later step reads the real rows instead of a summary.
 *  - **`status` is set in code where code can know it** (a failed run is `failed`) and
 *    by the model only for the judgment cases it alone can make — `needs_input`,
 *    `out_of_scope`, `no_information`, and `incomplete` — via a short trailing tag. A model
 *    that gives no structure defaults to `done` on a clean end — never a parse error.
 *
 *  - **`no_information`** (design-discussion.md §13.2(b), TASKS #143): a domain-knowledge
 *    step (MCP Operator) that searched a server which genuinely fits the request but found
 *    nothing relevant to it. Deliberately distinct from a role reporting no *server* fits at
 *    all when none is connected — that case is decided in code before the step ever runs
 *    (`isRoleAvailable`, TASKS #145) and never reaches this tag; this one can only be judged
 *    by a model that actually looked at the content.
 *
 *  - **`incomplete`** (TASKS #178): distinct from `no_information` — a domain-knowledge step
 *    (MCP Operator or Research) that found *some* genuinely relevant content, but not enough
 *    to fully answer the request. Found live: a wiki search returned real hits from the right
 *    document, but the snippets were a table fragment and a bibliography entry — not nothing,
 *    but not usable either — and it got reported as `done` because the binary done/no_information
 *    choice had no room for "found something, but it's thin." `executePlan` reacts to this
 *    status in code (`ensureFollowUpOnIncomplete`) by inserting one bounded follow-up step to
 *    the other information source, rather than leaving it to a hopeful note the way
 *    `no_information`'s fallback does — see that function's own doc comment for why the two
 *    statuses get different code-level treatment.
 */
export type HandoffStatus = 'done' | 'needs_input' | 'out_of_scope' | 'no_information' | 'incomplete' | 'failed'

/** A captured tool result saved to a workspace file for later steps. */
export interface HandoffDataFile {
  /** Workspace-relative, forward slashes. */
  path: string
  tool: string
  /** e.g. "30 rows" or "12,400 characters". */
  summary: string
}

export interface DelegateResult {
  role: AgentRole
  status: HandoffStatus
  /** The specialist's own closing text, with any handoff tag removed. */
  summary: string
  /** Workspace-relative paths created or changed during the run, derived in code. */
  artifacts: string[]
  dataFiles: HandoffDataFile[]
  /** `needs_input`: what the specialist needs from the user. `out_of_scope`: why. */
  blocker?: string
  /** `out_of_scope`: the role the specialist believes should take it (validated by the caller). */
  suggestedRole?: string
  /** True when `status` is `failed` — what the rest of the code paths already call `isError`. */
  isError: boolean
}

/** What a later step is shown from earlier steps in the same turn. */
export interface HandoffItem {
  fromRole: AgentRole
  kind: 'data' | 'file'
  path: string
  note: string
}

// --- Trailing tag ---------------------------------------------------------------

const TAG = /\[handoff:\s*(needs_input|out_of_scope|no_information|incomplete)(?:\s*(?:->|→)\s*([a-z][a-z0-9-]*))?\s*\]/gi
/** A tag only counts near the end of the reply — an earlier mention (quoting the instruction back) is just text. */
const TAG_TAIL_CHARS = 1200

export interface ParsedTag {
  status?: 'needs_input' | 'out_of_scope' | 'no_information' | 'incomplete'
  suggestedRole?: string
  /** Text after the tag: the question (`needs_input`), the reason (`out_of_scope`), what was searched (`no_information`), or what's still missing (`incomplete`). */
  detail?: string
  /** The reply with the tag (and its trailing detail) removed. */
  text: string
}

export function parseHandoffTag(reply: string): ParsedTag {
  const tailStart = Math.max(0, reply.length - TAG_TAIL_CHARS)
  let last: RegExpExecArray | undefined
  for (const m of reply.matchAll(TAG)) if (m.index >= tailStart) last = m
  if (!last) return { text: reply }
  const detail = reply.slice(last.index + last[0].length).trim()
  return {
    status: last[1].toLowerCase() as 'needs_input' | 'out_of_scope' | 'no_information' | 'incomplete',
    suggestedRole: last[2]?.toLowerCase(),
    detail: detail || undefined,
    text: reply.slice(0, last.index).trim()
  }
}

/** The instruction appended to every specialist prompt (see agents/roles.ts). */
export const HANDOFF_TAG_INSTRUCTION =
  ' If the request is outside your role, end your reply with a final line `[handoff: out_of_scope -> <role-id>]` naming the role that ' +
  'should take it (and a short reason after the tag) instead of improvising. If you cannot continue without something from the user, ' +
  'end with `[handoff: needs_input]` followed by your question. Otherwise add no tag.'

// --- Code-derived artifacts: see tools/workspace-snapshot.ts ---------------------

export { snapshotWorkspace, diffSnapshots, type WorkspaceSnapshot, type SnapshotDiff } from '../tools/workspace-snapshot'

// --- Data capture ---------------------------------------------------------------

export const HANDOFF_DIR = '.sachiv-handoff'

const DATA_TOOLS = new Set(['db_execute_sql', 'db_list_rows', 'db_find_rows', 'parse_csv', 'parse_json', 'parse_xml', 'parse_html', 'api_call', 'xlsx_read', 'web_search'])

/** Results shorter than this are already fully visible in a summary — not worth a file. */
const MIN_CAPTURE_CHARS = 150
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024
export const MAX_DATA_FILES_PER_DELEGATE = 6

export function isCapturableDataTool(name: string): boolean {
  return DATA_TOOLS.has(name) || name.startsWith('db_query_')
}

/**
 * TASKS.md #172: used to regex-parse the chat header's claimed row count ("52704 row(s):") and
 * report that as the handoff summary — but the driver-level cap (`MAX_RETURNED_ROWS`, each
 * `*-driver.ts`) means the header's count and what's actually captured to disk can differ, so a
 * later step reading this summary was told "52704 rows" for a file that genuinely has 200.
 * Counting the real parsed array length (when the capture is JSON) is honest regardless of what
 * the header claims; the regex stays only as a fallback for a non-JSON (`.txt`) capture.
 */
function describeCapture(content: string, pureJson: string | undefined): string {
  if (pureJson !== undefined) {
    try {
      const parsed: unknown = JSON.parse(pureJson)
      if (Array.isArray(parsed)) return `${parsed.length} rows`
    } catch {
      // not a JSON array after all — fall through to the header-text guess below
    }
  }
  const m = /^(\d+) row\(s\):/.exec(content)
  if (m) return `${m[1]} rows`
  return `${content.length.toLocaleString('en-US')} characters`
}

/**
 * Found live (manual_testing.md section 4, Prompt B, 2026-10-01): a captured `db_execute_sql` file
 * started with the literal line `30 row(s):` before its JSON array — a header meant for the chat
 * transcript, not a data file — and `json.load()` on it failed with "Extra data". The Developer step
 * burned several rounds (`od -c`, `head -c`, manual trial and error) discovering that and working
 * around it by skipping the first line. Several other data tools (`api_call`'s `"200 OK\n{...}"`,
 * `parse_csv`'s `"N row(s):\n[...]"`) share the same shape: a short human-readable line, then the real
 * JSON payload. Rather than special-case every tool's exact header text, find the first `[`/`{` and
 * confirm everything from there really is valid JSON — if so, THAT (not the original string) is what
 * gets written to disk, so a later step's script can `json.load()` the file directly. The header stays
 * in `content` for `describeCapture`'s summary and in whatever the model sees in the chat transcript —
 * only the on-disk file handed to the next step is cleaned.
 */
function extractPureJson(content: string): string | undefined {
  const start = content.search(/[[{]/)
  if (start < 0) return undefined
  const candidate = content.slice(start)
  try {
    JSON.parse(candidate)
  } catch {
    return undefined
  }
  return candidate
}

/**
 * Saves one tool result under `<root>/.sachiv-handoff/<turnId>/` and returns its handoff
 * record, or `undefined` when it is not worth capturing.
 */
export async function saveHandoffData(root: string, turnId: string, seq: number, tool: string, content: string): Promise<HandoffDataFile | undefined> {
  if (content.length < MIN_CAPTURE_CHARS) return undefined
  const pureJson = extractPureJson(content)
  const ext = pureJson !== undefined ? 'json' : 'txt'
  const toWrite = pureJson ?? content
  const body = Buffer.byteLength(toWrite) > MAX_CAPTURE_BYTES ? toWrite.slice(0, MAX_CAPTURE_BYTES) + '\n[...truncated at 2 MB...]' : toWrite
  const rel = `${HANDOFF_DIR}/${turnId}/${String(seq).padStart(2, '0')}-${tool.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`
  try {
    await mkdir(path.join(root, HANDOFF_DIR, turnId), { recursive: true })
    await writeFile(path.join(root, rel), body, 'utf-8')
  } catch {
    return undefined // capture is best-effort; the run itself must never fail because of it
  }
  return { path: rel, tool, summary: describeCapture(content, pureJson) }
}

/** Removes handoff folders older than `maxAgeMs`. Best-effort. */
export async function pruneHandoffDirs(root: string, maxAgeMs: number, now = Date.now()): Promise<void> {
  const base = path.join(root, HANDOFF_DIR)
  let names: string[]
  try {
    names = await readdir(base)
  } catch {
    return
  }
  for (const name of names) {
    try {
      const s = await stat(path.join(base, name))
      if (now - s.mtimeMs > maxAgeMs) await rm(path.join(base, name), { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

// --- Formatting -----------------------------------------------------------------

const MAX_LISTED = 12

/**
 * What the router (or a later plan step) sees for a delegate's result. With nothing to
 * report — a plain `done`/`failed` with no files and no captured data — this is exactly
 * the specialist's own text, so an ordinary reply is unchanged.
 */
export function formatDelegateResult(r: DelegateResult): string {
  const parts: string[] = [r.summary]
  if (r.artifacts.length) {
    const shown = r.artifacts.slice(0, MAX_LISTED)
    parts.push(`Files created or changed (verified by the app, not self-reported): ${shown.join(', ')}${r.artifacts.length > MAX_LISTED ? `, and ${r.artifacts.length - MAX_LISTED} more` : ''}`)
  }
  if (r.dataFiles.length) {
    parts.push(`Data captured for later steps: ${r.dataFiles.map((d) => `${d.path} (${d.tool}, ${d.summary})`).join('; ')}`)
  }
  if (r.status === 'needs_input') {
    parts.push(`NEEDS INPUT — this specialist cannot continue without the user${r.blocker ? `: ${r.blocker}` : '.'} Ask the user; do not guess or invent the missing information.`)
  }
  if (r.status === 'out_of_scope') {
    parts.push(`OUT OF SCOPE — this request is outside this specialist's role${r.blocker ? ` (${r.blocker})` : ''}${r.suggestedRole ? `; suggested: delegate_to_${r.suggestedRole.replace(/-/g, '_')}` : ''}.`)
  }
  if (r.status === 'no_information') {
    parts.push(`NO INFORMATION FOUND — the connected source(s) had nothing relevant to this request${r.blocker ? `: ${r.blocker}` : '.'}`)
  }
  return parts.filter((p) => p.trim().length > 0).join('\n\n')
}

/** The "inputs" section appended to a delegate's brief — real outputs of earlier steps in this turn. */
export function formatInputs(items: readonly HandoffItem[]): string {
  if (items.length === 0) return ''
  const recent = items.slice(-MAX_LISTED)
  const lines = recent.map((i) => `- ${i.kind === 'data' ? 'Data' : 'File'} from ${i.fromRole}: ${i.path} — ${i.note}`)
  return (
    '\n\nInputs from earlier in this turn (real outputs — read and use these files; never invent, assume or retype the data):\n' + lines.join('\n')
  )
}
