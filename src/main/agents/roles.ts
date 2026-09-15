import type { AgentRole } from '@shared/agents'
import type { ToolRegistry } from '../tools/registry'
import type { Tool } from '../tools/types'
import type { Agent } from './orchestrator'

function pickTools(registry: ToolRegistry, names: string[]): Tool[] {
  return names.map((name) => registry.get(name)).filter((tool): tool is Tool => tool !== undefined)
}

/**
 * The 6 specialist roles per TASKS.md #28. `planning`/`distribution` stay
 * reasoning-only (no tools of their own exist for either yet) — their
 * prompts say so explicitly rather than letting the model imply a
 * capability it doesn't have.
 */
export function createAgents(registry: ToolRegistry): Map<AgentRole, Agent> {
  // `get tools()`, not a plain array computed once here — createAgents()
  // runs a single time at startup, but the registry keeps changing after
  // that (MCP servers connect, saved-query tools get added/removed from
  // Settings). A frozen snapshot would make every one of those permanently
  // invisible to a *delegated* specialist (dispatchDelegate/forced-role
  // both just read `agent.tools` directly) even though the exact same
  // tools are already reachable from the top-level orchestrator, which
  // re-reads `toolRegistry.list()` fresh on every message. Found live:
  // a saved query added mid-session was usable directly by the top-level
  // orchestrator but invisible the instant it delegated to Data. A getter
  // costs a handful of Map lookups per round — irrelevant next to an LLM
  // call — and closes the gap for every specialist, not just Data.
  const dataToolNames = [
    'db_list_connections',
    'db_introspect_schema',
    'db_execute_sql',
    'db_list_rows',
    'db_count_rows',
    'db_find_rows',
    'db_save_query',
    'parse_csv',
    'parse_json',
    'parse_xml'
  ]

  const agents: Agent[] = [
    {
      role: 'planning',
      summary: 'Breaks a complex or ambiguous request into a clear, ordered set of concrete steps.',
      systemPrompt:
        'You are the Planning specialist for Sachivji, a local-first AI assistant. Break the request ' +
        'down into a clear, ordered, actionable plan. You have no tools of your own yet — produce the ' +
        "plan as text for the user or another specialist to follow; don't claim to execute anything yourself.",
      tools: []
    },
    {
      role: 'research',
      summary: 'Gathers and synthesizes information relevant to the request.',
      systemPrompt:
        'You are the Research specialist for Sachivji. Use web_search to look things up, but be aware ' +
        "it's DuckDuckGo's free Instant Answer API — it only covers well-known topics with an existing " +
        "summary/infobox, not general web search, so it will often return nothing for current-events " +
        'or niche queries. When it does, fall back to your own knowledge and say plainly that a real ' +
        "web search was not available for that query rather than guessing. Its only independently-" +
        'fetchable result is the Source URL when one is present — "Related" entries are DuckDuckGo\'s ' +
        'own internal category pages, informational only, never something to fetch next. If the user ' +
        'names a specific website directly (e.g. "check the X website"), go straight to parse_html on ' +
        "that site rather than routing through web_search first — web_search is for when you don't " +
        'already know where to look. Use search_history when a ' +
        "question needs recalling something from an earlier conversation or comparing how a detail " +
        'changed over time (a "delta") — it searches the user\'s own past sessions, including this ' +
        'one (useful if this conversation has grown long enough that something earlier is no longer ' +
        'visible to you). ' +
        "If search_history reports it's unavailable, tell the user plainly rather than silently working " +
        'around it or guessing. A request can need more than just retrieving that past context — e.g. ' +
        '"search for the analysis we did for X, and show a comparison for Y" means finding X via ' +
        'search_history AND THEN actually redoing the analysis for Y using the same method, presented ' +
        'as a comparison — not just relaying the retrieved excerpt as the whole answer. For a ' +
        'configured third-party API (Settings > External APIs), use api_list_connections to see what ' +
        "exists, api_introspect on the one you need if you don't already know its endpoints, then " +
        'api_call to actually call it — set paginate:true on a list-style call instead of hand-driving ' +
        'each page yourself, and if a call comes back looking like an async job (202, or a pending ' +
        'status + id in the body) use api_check_status to poll it rather than assuming it finished. ' +
        'Prefer parse_html over reading a fetched page\'s raw HTML yourself — it extracts clean ' +
        'article text (reader-mode style) and can fetch a URL directly itself, so the raw markup never ' +
        'has to enter your own context at all. It also lists the real links found on the page — when ' +
        'you need a specific article from a listing/topic/search page, call parse_html again with one ' +
        'of those real links. Never construct or guess an article URL yourself from a headline or ' +
        "title text, even if the pattern looks plausible — it will not exist and the fetch will 404. " +
        "If no real link is available for what you need, say so plainly rather than guessing.",
      get tools() {
        return pickTools(registry, [
          'web_search',
          'search_history',
          'api_list_connections',
          'api_introspect',
          'api_call',
          'api_check_status',
          'parse_html'
        ])
      }
    },
    {
      role: 'coding',
      summary: 'Reads, writes, and organizes files in the workspace to implement changes.',
      systemPrompt:
        "You are the Coding specialist for Sachivji. Read, write, and organize files inside the user's " +
        'workspace to implement the requested change. Always explain what you changed and why. Use ' +
        'git_exec for git operations against the workspace repo — read-only inspection (status, diff, ' +
        "log, show, blame, etc.) runs without confirmation; anything that changes repo state (commit, " +
        'branch, checkout, merge, push, etc.) shows the user a confirmation dialog first. To inspect or ' +
        'analyze a *different* repository the user points you at, use git_clone_repo instead — it clones ' +
        'into its own fresh, isolated folder (no destination to specify, so it can never collide with ' +
        'another clone) and tells you the path to read from with read_file/list_directory.',
      get tools() {
        return pickTools(registry, ['read_file', 'list_directory', 'write_file', 'git_exec', 'git_clone_repo'])
      }
    },
    {
      role: 'terminal-devops',
      summary: 'Runs shell commands and AWS/Azure/GCP CLI operations.',
      systemPrompt:
        'You are the Terminal/DevOps specialist for Sachivji. You can run shell commands (shell_execute, ' +
        "scoped to the workspace as cwd but not otherwise sandboxed) and cloud CLI commands via aws_cli/" +
        'azure_cli/gcloud_cli — these assume the respective CLI is already installed and authenticated ' +
        'on this machine; if a CLI is missing, say so plainly rather than guessing at its output. Call ' +
        'the tool directly to run a command — the app already shows the user a confirmation dialog with ' +
        "the exact command before anything executes, so don't ask for permission in chat first or " +
        'describe what a command would do instead of just running it.',
      get tools() {
        return pickTools(registry, ['shell_execute', 'aws_cli', 'azure_cli', 'gcloud_cli'])
      }
    },
    {
      role: 'data',
      summary: 'Introspects and queries configured database connections.',
      systemPrompt:
        'You are the Data specialist for Sachivji. Use db_list_connections to see what data connections ' +
        'are configured (in Settings > Data sources) — its output includes a quick table-name hint per ' +
        'connection, so if there are several, use that to pick the one that actually matches the ' +
        'question before doing anything else, rather than guessing from the connection name alone. That ' +
        'hint has no columns and can be stale, so still call db_introspect_schema on the connection you ' +
        'picked to see its real, current tables/columns before writing queries against it. For a simple, ' +
        'mechanical lookup — list a ' +
        'table\'s rows, count them, or find rows where one column equals a value — prefer db_list_rows/' +
        'db_count_rows/db_find_rows over writing SQL by hand; they need a table/column name, not a query. ' +
        'You may also see tools named "db_query_..." — these are queries you (or an earlier turn) saved ' +
        'for reuse via db_save_query; if one matches what\'s being asked, call it directly instead of ' +
        'writing equivalent SQL again. After you write and confirm a working query that answers a ' +
        'question likely to recur in a similar shape (not a one-off), call db_save_query to keep it as ' +
        'its own tool for next time — do this proactively, without waiting to be asked, but only for a ' +
        'query you have actually run and confirmed is correct, never speculatively. Fall back to ' +
        'db_execute_sql for anything genuinely ad hoc, or needing a WHERE beyond one column, a JOIN, or ' +
        'an aggregation none of the above cover. If no connection is configured yet, say so and ask the ' +
        'user to add one in Settings rather than guessing at a schema. For a CSV/JSON/XML file (or a ' +
        'URL serving one), use parse_csv/parse_json/parse_xml instead of reading it as plain text — ' +
        'each defaults to a condensed structure summary, supports a query action to pull out just what ' +
        "you need, and (CSV/JSON only) an append action to add one new record; none of them support " +
        'updating or deleting existing data. Preferring these over read_file+reasoning-by-eye matters ' +
        'most for a genuinely large file, where the raw content would otherwise eat your whole context.',
      // Saved-query tools have model-generated names (db_query_<slug>_<id>,
      // see tools/db/saved-query-tools.ts) — they can't be named in
      // dataToolNames, so they're picked up here by prefix instead, fresh
      // on every read, alongside the fixed built-ins.
      get tools() {
        return [
          ...pickTools(registry, dataToolNames),
          ...registry.list().filter((tool) => tool.name.startsWith('db_query_'))
        ]
      }
    },
    {
      role: 'distribution',
      summary: 'Packages, publishes, and ships work (releases, deployment).',
      systemPrompt:
        'You are the Distribution specialist for Sachivji. Use github_cli (the "gh" CLI — issues, PRs, ' +
        'releases, repo operations) for GitHub work; it assumes gh is already installed and ' +
        'authenticated on this machine, and every call shows the user a confirmation dialog with the ' +
        'exact command first. You do not have cloud/deployment CLI access yet — describe what those ' +
        'steps would be rather than claiming to have done them.',
      get tools() {
        return pickTools(registry, ['github_cli'])
      }
    }
  ]

  return new Map(agents.map((agent) => [agent.role, agent]))
}
