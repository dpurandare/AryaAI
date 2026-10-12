import type { AgentRole } from '@shared/agents'
import type { Tool } from '../tools/types'
import type { Agent } from './orchestrator'

/**
 * The slim router's hot core (design-discussion.md 3.1). A tool is here only if it is
 * (a) usage-backed — real calls in the session DB, never "because it is easy to describe" —
 * and (b) budget-safe: the whole core stays under a token cap, enforced by the prompt-budget
 * test. The single exception is `describe_capabilities`: new, required infrastructure with no
 * usage history yet.
 *
 * Evidence (session DB, 2026-09-25, 111 real calls): shell_execute 37, read_file 6, write_file
 * 6, list_directory 3, web_search 4 (across 3 sessions). The SQL trio (14 calls across 3
 * sessions) is deliberately NOT here — approved default: it stays with Data Access until usage
 * and the token cap justify it. `python_run` is not core either: it belongs to the Developer,
 * which is where "write a script and run it" should go.
 *
 * The `tool_usage_log` table (db/tool-usage-log.ts) records real calls from now on, so this list
 * can be revised from data instead of a one-day sample.
 */
export const ROUTER_CORE_TOOLS: readonly string[] = [
  'describe_capabilities',
  'get_environment',
  'mcp_list_connections',
  'shell_execute',
  'read_file',
  'list_directory',
  'write_file',
  'web_search'
]

/** Core-tool schema cap (tokens, tiktoken o200k_base) enforced by prompt-budget.test.ts. */
export const ROUTER_CORE_TOKEN_CAP = 1_200

/**
 * What the slim router carries: the hot core, plus everything it MUST keep:
 *  - tools no specialist owns (the deck-building flow — pptx_start_deck / pptx_add_slide /
 *    pptx_save_deck — is router-only because a specialist cannot delegate to Page Creator).
 * Everything else a specialist owns is reached with its delegate tool — MCP tools included: since
 * design step 5 they belong to the MCP Operator alone, so a server with 144 tools adds nothing here.
 */
/**
 * Every tool except the connected MCP servers' (`mcp__<server>__<tool>`), which belong to the MCP Operator alone. Used
 * by the full router too, not just the slim one: found live, a "look up X in the wiki" request had the top-level
 * assistant call the wiki tools itself — no MCP Operator, none of its server-description and honest-no-result
 * handling — and a manual-test routing row expecting the Operator missed. With no MCP tools in its list, the router can
 * only reach a server by delegating.
 */
export function withoutMcpTools(all: readonly Tool[]): Tool[] {
  return all.filter((t) => !t.name.startsWith('mcp__'))
}

/** Tools only a specialist uses; the router never calls them, and each costs tokens on every request it makes. */
const SPECIALIST_ONLY_TOOLS: ReadonlySet<string> = new Set(['save_research_note', 'read_research_notes'])

/**
 * The Configurator's own connection-setup tools (roles.ts: "you only set connections up — using them afterwards is
 * another specialist's job"). Found live, TASKS.md #202, with both gpt-4o-mini and gpt-4o: left reachable directly
 * from the full router, a model asked to use an already-configured MCP server retried `mcp_create_connection`
 * against it instead of delegating, since a plausible-looking tool was sitting right there (slim router already
 * excluded these the same way `selectRouterTools` excludes every specialist-owned tool; full router did not, since
 * it only ever filtered by MCP-prefix and the small SPECIALIST_ONLY_TOOLS set). Named explicitly rather than
 * excluding by ownership generally, because the full router deliberately keeps some tools a specialist owns too —
 * `find_stock_images`/`download_image` (Researcher-owned) are needed directly for the deck-building flow, which is
 * router-only since no specialist can delegate to Page Creator; a blanket ownership exclusion would silently break that.
 */
const CONNECTION_SETUP_TOOLS: ReadonlySet<string> = new Set(['mcp_create_connection', 'db_create_connection', 'api_create_connection'])

/** What the FULL router sees: no MCP tools (see withoutMcpTools), no specialist-only tools, and no connection-setup tools (see CONNECTION_SETUP_TOOLS). */
export function fullRouterTools(all: readonly Tool[]): Tool[] {
  return withoutMcpTools(all).filter((t) => !SPECIALIST_ONLY_TOOLS.has(t.name) && !CONNECTION_SETUP_TOOLS.has(t.name))
}

export function selectRouterTools(all: readonly Tool[], agents: ReadonlyMap<AgentRole, Agent>): Tool[] {
  // User-defined roles never count as a tool's owner: a role file naming `pptx_add_slide` must not make the slim router drop the deck flow.
  const owned = new Set([...agents.values()].filter((a) => !a.custom).flatMap((a) => a.tools.map((t) => t.name)))
  const core = new Set(ROUTER_CORE_TOOLS)
  // MCP tools are dropped by rule (not merely because the operator owns them right now): they must never reach the router's tool list.
  return withoutMcpTools(all).filter((t) => core.has(t.name) || !owned.has(t.name))
}
