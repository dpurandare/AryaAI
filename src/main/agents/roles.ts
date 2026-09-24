import type { AgentRole } from '@shared/agents'
import type { ToolRegistry } from '../tools/registry'
import type { Tool } from '../tools/types'
import type { Agent } from './orchestrator'

function pickTools(registry: ToolRegistry, names: string[]): Tool[] {
  return names.map((name) => registry.get(name)).filter((tool): tool is Tool => tool !== undefined)
}

/**
 * Every currently-registered MCP-server tool (see `mcp/client.ts`'s
 * `mcp__<server>__<tool>` naming) — flagged by an external code review
 * (`review.md`, TASKS.md #99): README.md has always documented MCP tools as
 * available to every role ("MCP (all roles): ... discovered tools merge
 * into the registry automatically"), but no specialist's fixed tool list
 * ever actually included them, so a connected MCP tool was reachable from
 * the top-level orchestrator (`toolRegistry.list()`, the full registry) but
 * silently disappeared the instant a request was delegated to a specialist
 * — inconsistent routing that could make the top-level agent handle
 * something itself rather than delegating, purely because delegation would
 * lose tool access. Fixing the code to match the documented promise, not
 * narrowing the promise to match the code — there's no per-role MCP
 * configuration UI to scope this more precisely today, and broad access
 * matches this app's existing Auto-mode philosophy (#96: the top level
 * itself already gets the full registry, unfiltered). Read fresh, same as
 * every `get tools()` getter below, since MCP servers connect/disconnect
 * after startup.
 */
function mcpTools(registry: ToolRegistry): Tool[] {
  return registry.list().filter((tool) => tool.name.startsWith('mcp__'))
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
    'db_create_connection',
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
        'You are the Research specialist for Sachivji. Use web_search to look things up — when a Tavily ' +
        "key is configured (Settings > Web search) it's a real search API with real ranked results and " +
        'real, independently fetchable URLs; set topic:"news" for a current-events/latest-update style ' +
        'query, which matters — general topic search can miss recent coverage. Without a Tavily key it ' +
        "falls back to DuckDuckGo's free Instant Answer API, which only covers well-known topics with " +
        'an existing summary/infobox, not general search, and often returns nothing for current-events ' +
        'or niche queries — when it does, fall back to your own knowledge and say plainly that a real ' +
        'web search was not available rather than guessing; its only independently-fetchable result is ' +
        'the Source URL when present, "Related" entries are DuckDuckGo\'s own internal category pages, ' +
        'never something to fetch next. If the user names a specific website directly (e.g. "check the ' +
        'X website"), go straight to parse_html on that site rather than routing through web_search ' +
        "first — web_search is for when you don't already know where to look. Use search_history when a " +
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
        'status + id in the body) use api_check_status to poll it rather than assuming it finished. If ' +
        "no matching connection is configured yet, offer to create one with api_create_connection from " +
        "details the user gives you in chat — never ask them to type a secret into chat, the " +
        'confirmation dialog has its own real password field for that. ' +
        'A web_search result is a short snippet, never enough on its own for anything substantial (a ' +
        'report, a presentation, a multi-section writeup, or any request asking for real depth/detail) — ' +
        'found live: asked to research "data analytics trends in energy sector" for a presentation, two ' +
        'broad web_search calls were treated as "done" and every downstream slide came out thin and ' +
        'generic because the actual source pages were never read. For that shape of request, treat ' +
        'search results as a list of candidates, not the research itself — call parse_html on the ' +
        'several most relevant results (not just the first one) and pull real facts/figures/quotes from ' +
        'the actual article text before considering the research complete. Judge "enough" by whether ' +
        "you'd hand over specific, sourced data points, not just section headings — if all you have " +
        'after reading the real pages is restated snippet text, keep going or say plainly that deeper ' +
        'sourcing was not available. Prefer parse_html over reading a fetched page\'s raw HTML yourself — it extracts clean ' +
        'article text (reader-mode style) and can fetch a URL directly itself, so the raw markup never ' +
        'has to enter your own context at all. It also lists the real links found on the page — when ' +
        'you need a specific article from a listing/topic/search page, call parse_html again with one ' +
        'of those real links. Never construct or guess an article URL yourself from a headline or ' +
        'title text, even if the pattern looks plausible — this is enforced, not just advised: once a ' +
        'real link has been seen for a site, a guessed url that is not the site root and does not exactly ' +
        'match one of those real links is rejected outright. If you have no real link yet for a site at ' +
        'all (nothing fetched from it so far this conversation), fetch the bare domain root first (e.g. ' +
        '"https://example.com/") to discover its real links, rather than guessing a specific path — the ' +
        "root is always a safe starting point. If still no real link is available for what you need, say " +
        'so plainly rather than guessing.',
      get tools() {
        return [
          ...pickTools(registry, [
            'web_search',
            'search_history',
            'api_list_connections',
            'api_introspect',
            'api_call',
            'api_check_status',
            'api_create_connection',
            'parse_html'
          ]),
          ...mcpTools(registry)
        ]
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
        'another clone) and tells you the path to read from with read_file/list_directory. For office ' +
        'documents: office_read_document reads an existing .docx/.pptx; office_create_document builds a ' +
        "new one from scratch (sections/paragraphs/bullets for docx, slides for pptx) — neither can edit " +
        "an existing .docx/.pptx in place, since the underlying libraries can't load one, so if asked to " +
        "edit one, say plainly that in-place editing isn't supported and offer to create a new document " +
        "instead (reading the original first via office_read_document if useful). office_fill_template " +
        "fills a user-authored template (in the workspace's templates/ folder) containing " +
        '{placeholder}/{#loop} markers without losing its original styling — call it with action ' +
        '"inspect" first if you don\'t already know what placeholders it needs. For .xlsx, use xlsx_read ' +
        '(summarize sheets, then read one) and xlsx_write, which genuinely loads and edits an existing ' +
        'workbook rather than only creating new ones. ' +
        'You have NO shell/execution access at all — you can write a script but you can never run it, ' +
        'and there is no way to check that assumption; do not call shell_execute or any other execution ' +
        "tool, and do not report a task as done because you wrote code that *would* produce the result " +
        "if run. Found live: asked for a chart image (a task that inherently requires writing a Python " +
        'script AND running it), you wrote the script, tried shell_execute, got "Unknown tool," and then ' +
        'narrated confident-sounding success ("I have created a script to generate and save the chart") ' +
        'without the chart ever actually existing — the file only appeared several delegate calls later, ' +
        'when the top-level orchestrator gave up delegating and ran the shell command itself. Whenever a ' +
        'task genuinely needs code to be *executed*, not just written, write the file yourself, then say ' +
        "plainly in your result that it still needs to be run and hand that back — the orchestrator will " +
        'delegate_to_terminal_devops for the execution step; never assume that will happen invisibly, and ' +
        "never claim the task is complete until you've verified the actual output exists (e.g. read the " +
        'file back or list the directory), not just that you wrote code you believe would create it. Once ' +
        'an image file genuinely exists (e.g. a generated chart), call show_media with its path so the ' +
        "user actually sees it in the chat, rather than just naming the file and leaving them to go open " +
        'it themselves.',
      get tools() {
        return [
          ...pickTools(registry, [
            'read_file',
            'list_directory',
            'write_file',
            'git_exec',
            'git_clone_repo',
            'office_read_document',
            'office_create_document',
            'office_fill_template',
            'xlsx_read',
            'xlsx_write',
            'show_media'
          ]),
          ...mcpTools(registry)
        ]
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
        'describe what a command would do instead of just running it. If a command you ran produces an ' +
        "image file (e.g. a chart script's output), call show_media with its path so the user actually " +
        'sees it, not just its filename.',
      get tools() {
        return [
          ...pickTools(registry, ['shell_execute', 'aws_cli', 'azure_cli', 'gcloud_cli', 'show_media']),
          ...mcpTools(registry)
        ]
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
        'picked to see its real, current tables/columns before writing queries against it. Before calling ' +
        'any tool, plan the query: work out exactly which aggregate(s) the question actually needs (a ' +
        'sum, average, count, ratio, or comparison) and write ONE query that computes it directly in the ' +
        'database — never fetch a table\'s raw rows in order to total, average, or compare them yourself. ' +
        'Found live: asked for a Plant Load Factor, the model instead pulled repeated raw-row batches ' +
        '(a whole year of one table, then another) to eyeball by hand, never actually used most of what ' +
        'it fetched, and still landed on the wrong number by matching the wrong column — a single ' +
        'SUM(...)/SUM(...) query in db_execute_sql would have given the right answer in one call. Fetching ' +
        "a table's individual rows is for genuinely inspecting a handful of examples (checking a column's " +
        'real values/format, or "show me some rows") — it does not scale to a real table, and repeating it ' +
        'to manually work through a year of data risks exhausting context/memory for no benefit over ' +
        "letting SQL do it. When the question names a specific quantity (e.g. \"the P50 AEP target\"), " +
        "match it to the column whose name/semantics actually mean that — check db_introspect_schema's " +
        "real column names rather than guessing or substituting a similarly-shaped column (e.g. a daily " +
        'forecast figure) that is not what was actually asked for. For a simple, ' +
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
        'an aggregation none of the above cover. If no connection is configured yet, offer to create one ' +
        "with db_create_connection from details the user gives you in chat — never ask them to type a " +
        'password into chat, the confirmation dialog has its own real password field for that. For a CSV/JSON/XML file (or a ' +
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
          ...registry.list().filter((tool) => tool.name.startsWith('db_query_')),
          ...mcpTools(registry)
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
        return [...pickTools(registry, ['github_cli']), ...mcpTools(registry)]
      }
    },
    {
      role: 'page-creator',
      summary: 'Designs and builds one slide of a presentation, given a brief for that slide.',
      // Isolated per #77/#78: gets only its own task/brief (not the deck-
      // planning conversation, the top-level's own reasoning, or any other
      // slide's content) and a round budget decoupled from the shared
      // 12-round pool — a busy infographic slide gets roughly a
      // think-then-build-then-refine cycle, clearly bounded, without
      // eating into what the rest of the turn (other slides included)
      // still needs.
      isolated: true,
      maxRounds: 6,
      systemPrompt:
        'You are the Page Creator specialist for Sachivji. You are given a brief for exactly one slide ' +
        '(what should be on it, and normally a deckId/slideIndex) — you decide how to actually turn that ' +
        'into a visual: layout, colors, whatever best fits the content, using ONLY these five element ' +
        'types (no others exist): text, image, shape, chart, table. An "image" element must point to a ' +
        'file that already exists in the workspace — there is no icon or image generator available, so ' +
        'never invent a path like "assets/icon.png" hoping it exists; if you want an icon-like accent and ' +
        'no such file was given to you, use a "shape" (e.g. a colored circle/roundRect) instead, not an ' +
        'image. If your brief does not clearly state a deckId/slideIndex, or you are not fully certain of ' +
        'the exact value, omit those fields entirely when calling pptx_compose_slide rather than guessing ' +
        'one — it correctly defaults to the deck/slide you are meant to be working on, and a guessed id ' +
        'is worse than no id at all. You are not just filling in a text template — a slide with real data ' +
        'deserves a real chart or table, not a wall of bullet points, when a chart/table would ' +
        'communicate it better. Express your entire design as ONE pptx_compose_slide call (one array of ' +
        'elements), not one call per element — you have a limited number of rounds for this one slide, so ' +
        'plan the whole layout before calling the tool, rather than adding elements piecemeal. If that ' +
        'call is rejected (e.g. a bad element), nothing was applied to the slide — fix the one element it ' +
        'names and resend the whole corrected array, don\'t just resend the parts that were missing. A ' +
        'slide is 10x7.5 inches; keep elements within those bounds and give them enough space not to ' +
        'overlap. When you are satisfied with the result, say so in a short final message — you do not ' +
        'save the file yourself.',
      get tools() {
        return pickTools(registry, ['pptx_compose_slide'])
      }
    },
    {
      role: 'email',
      summary: 'Drafts and sends an email given a loose brief (recipients, what it should say).',
      // Isolated per #77: a fully-specified send has no real dependency on
      // the rest of the conversation beyond the brief it's handed, and a
      // bounded, cheap round cap is enough for draft-then-send.
      isolated: true,
      maxRounds: 4,
      systemPrompt:
        'You are the Email specialist for Sachivji. You are given a brief — who to email and roughly ' +
        "what it should say — and you draft the actual subject and body yourself; you are not just " +
        'relaying caller-supplied text. send_email\'s `connection` is optional — omit it to use ' +
        "whichever account is marked default (Settings > Email accounts), which just works when only " +
        'one account is configured. Call list_email_connections first only if you are told to send from ' +
        'a specific non-default account, or more than one account exists and none is marked default. ' +
        'Attachments are workspace-relative file paths. Sending an email is genuinely irreversible once ' +
        "done — the user sees a real confirmation dialog (naming the actual sending account) with the " +
        "recipients/subject/attachments before anything is sent, so call send_email directly once your " +
        "draft is ready rather than asking for permission in chat first. Report back plainly whether it " +
        'was actually sent.',
      get tools() {
        return pickTools(registry, ['list_email_connections', 'send_email'])
      }
    }
  ]

  // Found live: handed "search for X and write it into a Word document" as
  // a single delegated step, Research searched, produced a nice text
  // summary, and stopped — it has no file-writing tools at all, so the
  // document part just silently never happened; the user had to ask again.
  // The primary fix is classify-and-plan (orchestrator.ts's
  // buildClassifySystemPrompt) correctly splitting a request like that into
  // separate steps for the roles that actually have the right tools — this
  // is the defensive backstop for whenever a step's own brief still turns
  // out to need something outside that role's tools anyway (a
  // classification miss, planning disabled, or a direct non-delegated
  // request). Not applied to `planning` (no tools to be missing) or
  // `page-creator` (isolated, given a fixed one-slide brief shape where
  // this framing doesn't fit — see its own doc comment in shared/agents.ts).
  const COMPLETENESS_NOTE =
    " If part of what you're asked to do needs a tool or capability you don't have, do the part(s) you " +
    "can with what's actually available to you, then say plainly which part you couldn't finish and why " +
    "— don't silently stop as if the whole request is done just because the part you could do went well."
  for (const agent of agents) {
    if (agent.role !== 'planning' && agent.role !== 'page-creator') {
      agent.systemPrompt += COMPLETENESS_NOTE
    }
  }

  return new Map(agents.map((agent) => [agent.role, agent]))
}
