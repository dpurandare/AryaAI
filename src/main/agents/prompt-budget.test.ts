import { describe, expect, it } from 'vitest'
import { Tiktoken } from 'js-tiktoken/lite'
import o200k_base from 'js-tiktoken/ranks/o200k_base'
import { vi } from 'vitest'

// tools/setup.ts imports `electron` (and transitively the keychain) — same
// hazard and same mock as tools/setup.test.ts.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

import { ROLE_MANIFEST } from '@shared/agents'
const { createDefaultRegistry } = await import('../tools/setup')
const { createAgents } = await import('./roles')
const { Orchestrator } = await import('./orchestrator')
const { SYSTEM_PROMPT } = await import('./system-prompt')
const { createDescribeCapabilitiesTool } = await import('./capabilities')
const { ROUTER_CORE_TOKEN_CAP, ROUTER_CORE_TOOLS, fullRouterTools, selectRouterTools } = await import('./router-tools')

/**
 * The permanent prompt-budget test (design-discussion.md order-of-work step 1;
 * ctx.md). Measures what Sachivji sends to the model with NO conversation and
 * NO MCP servers — the fixed cost every request pays — and fails when it grows
 * past a recorded ceiling. Same estimator the app uses for non-Anthropic /
 * non-Google providers (tiktoken o200k_base), so +/-10% against a real
 * provider, but stable and comparable run to run.
 *
 * Two-way on purpose:
 *  - over the ceiling  -> the prompt grew: either trim it or raise the ceiling
 *    deliberately, in the same commit, with the reason.
 *  - well under it     -> the prompt shrank (the redesign's whole point): lower
 *    the ceiling so the saving cannot silently regress. A budget that only ever
 *    goes up is not a budget.
 */
const enc = new Tiktoken(o200k_base)
const tokens = (text: string): number => enc.encode(text).length
const schemaTokens = (defs: Array<{ name: string; description: string; inputSchema: unknown }>): number =>
  tokens(
    defs
      .map((t) => JSON.stringify({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
      .join('\n')
  )

/**
 * Baseline (step 1, 2026-09-26): routerPrompt 1,228 + routerToolSchemas 9,391 = 10,619; classify 778; roles
 * planning 59 / research 2,803 / coding 3,808 / terminal-devops 755 / data 2,982 / distribution 241 / page-creator 795 / email 535.
 * After step 2 (narrow roles, no duplicated roster, generated classify digest), same estimator:
 *   routerPrompt 862, routerToolSchemas 9,701 (10 delegate tools with contract-style summaries instead of 8), router bare 10,563 (-56: the
 *   router still carries the full registry — that is step 4), classify 833 (+55: live availability + the values-not-summaries rule);
 *   roles planning 59 / research 1,236 / history-analyst 411 / coding (Developer) 2,099 / data (Data Access) 2,513 / data-processor 1,808 /
 *   document-creator 2,216 / configurator 1,114 / page-creator 795 / email 535.
 * After step 3 (typed handoff): every specialist prompt gained the ~79-token `[handoff: ...]` instruction (research 1,315 / history 490 /
 * coding 2,211 — that plus a ~33-token "read the inputs files" line / data 2,592 / data-processor 1,887 / document-creator 2,295 /
 * configurator 1,193 / email 614); router and classify unchanged. The saving is on DELEGATED turns (Researcher -56%, Developer -45%). Ceilings sit ~2% above. Lower them as later steps land.
 * TASKS #143 (2026-09-27, design-discussion.md §13.2(b)): `mcp-operator` gained the `[handoff: no_information]` instruction,
 * covering both "no server fits" and "a server fits but found nothing relevant" — 360 -> 380 measured, ceiling raised to 390.
 * Deliberate growth, not drift: the tag is what lets a wiki-then-web fallback (#144) recognize either case at all.
 * TASKS #142 (2026-09-27, design-discussion.md §13.2(a)): `classifyPrompt` gained a named "domain knowledge + data" compound
 * pattern (mirrors the existing "write code AND run it" / "gather info, THEN save" named patterns) after the #139 probe
 * found the PLF question (wiki + database) planned inconsistently, sometimes even called `simple` — 887 -> 942 measured,
 * ceiling raised to 950. Deliberate growth: this is the fix, not drift.
 * Print the live numbers with `PRINT_BUDGET=1 npx vitest run src/main/agents/prompt-budget`.
 */
// TASKS.md #148 (2026-09-29): added find_files (a real, new capability — recursive/glob file search, the fix for
// the #148/#149 incident's 15-call list_directory loop), attached to coding/data-processor/document-creator
// alongside list_directory. Raised deliberately, not padded: routerBare/routerToolSchemas carry the full,
// unfiltered registry (#96 — the default top-level orchestrator has every tool, not just the slim router's
// filtered set), so one more real tool raises them regardless of role ownership; the three role ceilings that
// moved are exactly the three roles find_files was added to. slimRouterToolSchemas/slimRouterBare/routerCore are
// unchanged — selectRouterTools() correctly excludes find_files since it's owned by those specialists.
// TASKS.md #156 (2026-09-29): SYSTEM_PROMPT (routerPrompt/routerBare/slimRouterBare) gained the
// diagram/script/language-default rules (Mermaid for diagrams, Python for ad-hoc code, "script" as its own
// trigger for the native shell) — real, requested content, raised deliberately. role:coding also grew: the
// same defaults are restated in the Developer role's own prompt (matplotlib named explicitly, the OS-target
// shell fact interpolated from process.platform).
// 2026-10-01 (live Prompt-B failure, manual_testing.md section 4): Document Creator declined an
// image-embedding step and its own thinking considered "the Developer" but named the wrong role id
// (page-creator — a dead end, isolated/one-slide-only) in its `[handoff: out_of_scope -> ...]` tag.
// role:document-creator now states the id explicitly (`coding`) instead of leaving the model to guess it
// from a role list — 2130 -> 2172 measured, ceiling raised to 2220. buildOrchestratorSystemPrompt (every
// routerPrompt/routerBare/slimRouterBare number) also gained an instruction not to present a pre-existing
// workspace file as this turn's output — the second half of the same incident (the stalled plan's final
// round presented an old .docx, from a different session, as freshly created) — routerPrompt 1030 -> 1200
// measured, ceiling raised to 1230; routerBare/slimRouterBare raised to match.
// 2026-10-01 (same incident, the layout regression it caused): classify-and-plan's blanket "a
// file/document is its own step" rule had no carve-out for a document that needs a chart/image embedded
// in it, so it split chart generation (Developer) from "put it in a Word file" (Document Creator) across
// two roles — Document Creator cannot embed an image at all and only ever bounces that step back, and
// with the document-saving part framed as someone else's job, Developer's own step description never
// even asked for it, so Developer quietly over-delivered unasked, redundantly, on a worse second pass.
// classifyPrompt gained an explicit rule: chart/image generation AND embedding it into a document is ONE
// Developer step, never split and never routed to Document Creator for this — 942 -> 1104 measured,
// ceiling raised to 1150. Deliberate growth: this is the fix, not drift.
// TASKS.md #172: db_execute_sql's description gained truncation/aggregation-steering guidance (a
// silent driver-level row cap was found reporting a misleading "complete" row count; the fix adds
// honest-truncation reporting plus a nudge toward GROUP BY over raw row pulls) — 9930 -> 9934
// measured, routerToolSchemas/routerBare ceilings raised to cover it. Deliberate growth, not drift.
// TASKS.md #172 (continued): a live retest showed Developer calling python_run with no code at all
// right after reading two handoff files, so python_run's own description and the Developer role
// prompt both now say explicitly to read a `.sachiv-handoff/` file with real file I/O rather than
// retype its rows — 9940 -> 9968 (routerToolSchemas), 2710 -> 2751 (role:coding). Deliberate, not drift.
// Live-state fix (mcp_list_connections added to the router core, Configurator and MCP Operator; a fresh-state rule in
// the router prompt; a staleness note on search_history) — routerCore 800 -> 810, routerPrompt 1290 -> 1330,
// role:mcp-operator 580 -> 640, etc. Deliberate growth, not drift.
// Document-from-conversation fidelity rule (router prompt + Document Creator prompt): routerPrompt 1330 -> 1350,
// role:document-creator 2220 -> 2250. Found live: a Word doc built from an earlier answer dropped tables' columns, use cases, notes and queries. Deliberate.
// Final synthesis must not repeat step replies the user already saw (found live: the same top-5 list appeared three
// times) — routerPrompt 1350 -> 1390. Deliberate.
// Documents must not carry internal file paths/tool/step references (found live: a handoff .json path in a Word
// intro line) — role:document-creator 2290 -> 2310. Deliberate.
// Never state a value from an image/scan that could not be read (found live: an invented passport expiry date) —
// routerPrompt 1390 -> 1440, role:coding 2810 -> 2830. Deliberate.
// download_image + parse_html image listing + "never give a reason you did not observe" (found live: a photo could
// not be fetched and the model blamed login walls it never tested) — routerPrompt 1440 -> 1460, role:research
// 1350 -> 1530, parse_html 330 -> 335; web_search gains images:true (router core 810 -> 850), role:research -> 1580.
// Deliberate.
// Developer: scratch files go in tmp/, never loose in the workspace root (found live: 120 stray images from one
// scanned-passport session) — role:coding 2840 -> 2870. Deliberate.
// Outside-workspace access: the file tools' descriptions now say an absolute path elsewhere is possible (the user is
// asked first), which several roles carry — routerCore 850 -> ~890, role:coding/data-processor/document-creator up
// by ~50 each. Deliberate.
// 2026-10-09 (14.x, workspace location searched for in the MCP wiki): get_environment gives every specialist and the router the workspace path, OS, folders and
// date instead of a guess or a lookup. It costs its schema (~35 tokens) plus a one-line note per role: every router and role number rose by 40-90. Deliberate.
// 2026-10-09 (manual test 9.3, Anthropic haiku): after a direct delegation the router restated the specialist's reply, which the user had
// already seen, so the answer appeared twice. One sentence in buildOrchestratorSystemPrompt says not to — routerPrompt 1650 -> 1690
// (1672 measured), slimRouterBare 3950 -> 4000. Deliberate: this is the fix, not drift.
const CEILINGS = {
  // TASKS.md #178: the final-synthesis prompt now requires explicit disclosure when a plan step ended
  // PARTIAL INFORMATION, not just NEEDS INPUT/OUT OF SCOPE/FAILED — 1230 -> 1278. Deliberate, not drift.
  routerPrompt: 1730,
  // TASKS.md #172 (continued again): db_execute_sql's description reworded to describe the large-result
  // file-export behavior (writes to a file instead of "gets truncated") — 9970 -> 9983. Deliberate, not drift.
  routerToolSchemas: 11190,
  routerBare: 12920,
  slimRouterToolSchemas: 2390,
  slimRouterBare: 4120,
  routerCore: 990,
  // TASKS.md #179: the planning prompt's compound-step rule now explicitly says not to plan an MCP
  // Operator step AND a Research/web step for one domain-knowledge question up front (found live — a
  // pure definitional question got both, and web ran right after the wiki already gave a complete
  // answer) — 1150 -> 1255. Deliberate growth, not drift.
  classifyPrompt: 1290,
  'role:planning': 65,
  // TASKS.md #178: Research can now also report `[handoff: incomplete]` when filling an MCP gap only
  // partly closes it — 1340 -> 1345. Deliberate.
  'role:research': 2740,
  'role:history-analyst': 610,
  // TASKS.md #176/#177: found live retesting #172/#173/#175's fixes end-to-end — the resulting chart
  // compared a turbine's real data against... its own real data again (never recognized a real
  // `theoretical_power_kw` reference column already in the schema), plotted as a meaningless zigzag
  // (unsorted real data drawn as a line). role:coding 2760 -> 2801, role:data 2640 -> 2737. Deliberate.
  // 2026-10-09 (14.x, 100x100 images with 70%-height numbers): the Developer caught a font error, fell back to ImageFont.load_default() (which ignores the size)
  // and reported success three times; one sentence names a font that exists and bans the silent fallback — 3008 -> 3079. Deliberate: it is the fix.
  // TASKS.md #210: found live — a script calling input() hangs until python_run/shell_execute time out,
  // since neither connects stdin to anything. One rule bans writing interactive scripts, in favor of a
  // parametrized function called with real values (more reusable than a bare constant) — 3120 -> 3191. Deliberate.
  'role:coding': 3200,
  'role:data': 2860,
  'role:data-processor': 2230,
  'role:document-creator': 2440,
  'role:configurator': 1430,
  // TASKS.md #176: a weak/irrelevant search snippet (a table fragment, a citation) got reported as
  // real domain knowledge found, instead of retrying or reading further — 390 -> 514. Deliberate.
  // TASKS.md #178: MCP Operator can now report `[handoff: incomplete]` (found something, not enough)
  // distinct from `no_information` (found nothing) — 520 -> 567. Deliberate.
  // Manual test 8.2 (2026-10-08): MCP Operator searched the wiki for the user's own database. Added the "servers hold knowledge, never the user's data" rule
  // and trimmed the long "found live" retelling next to it — measured ~678, 640 -> 700. Deliberate: it is the rule that stops that.
  // 2026-10-12: mcp_list_connections now reports each connected server's actual tool names, not just a
  // count — found live: asked to list Context7's tools, the model had no way to get that and looped
  // calling this same tool 20 times before giving up with a vague non-answer. 770 -> 772. Deliberate.
  'role:mcp-operator': 772,
  'role:page-creator': 1400,
  'role:email': 700
} as const

function measure(): Record<keyof typeof CEILINGS, number> {
  const registry = createDefaultRegistry()
  const agents = createAgents(registry)
  registry.register(
    createDescribeCapabilitiesTool({
      getAgents: () => agents,
      getRegistry: () => registry,
      getConnections: () => ({ databases: [], apis: [], email: [] }),
      getRuntime: () => undefined
    })
  )
  const orchestrator = new Orchestrator(
    {} as never,
    'm',
    agents,
    SYSTEM_PROMPT,
    fullRouterTools(registry.list()),
    (async () => 'allow') as never,
    { workspaceGuard: { root: '/ws' }, currentSessionId: '' } as never,
    new AbortController().signal,
    { planningEnabled: true }
  ) as unknown as {
    buildOrchestratorSystemPrompt(): string
    buildClassifySystemPrompt(): string
    buildDelegateToolDefinitions(): Array<{ name: string; description: string; inputSchema: unknown }>
  }

  const routerPrompt = tokens(orchestrator.buildOrchestratorSystemPrompt())
  const routerToolSchemas = schemaTokens([...registry.toDefinitions(), ...orchestrator.buildDelegateToolDefinitions()])
  const slimTools = selectRouterTools(registry.list(), agents)
  const slimRouterToolSchemas = schemaTokens([...slimTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), ...orchestrator.buildDelegateToolDefinitions()])
  const routerCore = schemaTokens(ROUTER_CORE_TOOLS.map((n) => registry.get(n)!).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })))
  const result: Record<string, number> = {
    routerPrompt,
    routerToolSchemas,
    routerBare: routerPrompt + routerToolSchemas,
    slimRouterToolSchemas,
    slimRouterBare: routerPrompt + slimRouterToolSchemas,
    routerCore,
    classifyPrompt: tokens(orchestrator.buildClassifySystemPrompt())
  }
  for (const [role, agent] of agents) {
    result[`role:${role}`] = tokens(agent.systemPrompt) + schemaTokens(agent.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })))
  }
  return result as Record<keyof typeof CEILINGS, number>
}

describe('prompt budget (no conversation, no MCP servers)', () => {
  const measured = measure()

  if (process.env.PRINT_BUDGET) {
    // eslint-disable-next-line no-console
    console.info('PROMPT BUDGET\n' + Object.entries(measured).map(([k, v]) => `${k.padEnd(24)}${v}`).join('\n'))
  }

  it.each(Object.keys(CEILINGS) as Array<keyof typeof CEILINGS>)('%s stays within its ceiling and the ceiling is not stale', (key) => {
    const ceiling = CEILINGS[key]
    expect(measured[key], `${key} grew past its ceiling (${ceiling}); trim it, or raise the ceiling deliberately with the reason`).toBeLessThanOrEqual(ceiling)
    expect(measured[key], `${key} is well under its ceiling (${ceiling}) — lower the ceiling so the saving cannot regress`).toBeGreaterThan(ceiling * 0.9)
  })

  it(`the hot core stays under the design's ${ROUTER_CORE_TOKEN_CAP}-token cap (3.1: usage-backed AND budget-safe)`, () => {
    expect(measured.routerCore).toBeLessThanOrEqual(ROUTER_CORE_TOKEN_CAP)
  })

  it('every role in the manifest is measured', () => {
    expect(Object.keys(measured).filter((k) => k.startsWith('role:')).map((k) => k.slice(5))).toEqual(ROLE_MANIFEST.map((r) => r.id))
  })
})

/**
 * Per-tool schema budget (design 6: "fails when ... any single tool schema exceeds its budget"). Every tool has a ceiling; the
 * heaviest have their own, tight ones. A new tool, or a "helpful paragraph" added to an existing one, that pushes it past its
 * ceiling fails here — trim it, or raise the ceiling deliberately in the same commit with the reason. Measured 2026-09-26 (step 7,
 * after trimming office_create_document 794 -> 569 and office_extract_template 520 -> 395; 44 tools, 9,060 -> 8,710 in total).
 */
const DEFAULT_TOOL_CEILING = 320
const TOOL_CEILINGS: Record<string, number> = {
  office_create_document: 600, // + fromPreviousAnswer (copies the previous answer into a .docx whole)
  parse_csv: 450,
  office_extract_template: 410,
  pptx_compose_slide: 440,
  xlsx_write: 365,
  api_call: 360,
  db_create_connection: 350,
  mcp_create_connection: 340,
  parse_html: 335
}

describe('per-tool schema budget', () => {
  const registry = createDefaultRegistry()
  const tokensFor = (t: { name: string; description: string; inputSchema: unknown }): number =>
    schemaTokens([{ name: t.name, description: t.description, inputSchema: t.inputSchema }])

  it.each(registry.list().map((t) => [t.name, tokensFor(t)] as const))('%s stays within its ceiling', (name, tokens) => {
    const ceiling = TOOL_CEILINGS[name] ?? DEFAULT_TOOL_CEILING
    expect(tokens, `${name} is ${tokens} tokens, ceiling ${ceiling} — trim its description/schema, or raise the ceiling deliberately`).toBeLessThanOrEqual(ceiling)
  })

  it('every per-tool ceiling names a real tool, and is not stale (a saving must be locked in by lowering it)', () => {
    for (const [name, ceiling] of Object.entries(TOOL_CEILINGS)) {
      const t = registry.get(name)
      expect(t, `${name} is not registered`).toBeDefined()
      expect(tokensFor(t!), `${name} is well under its ceiling ${ceiling} — lower it`).toBeGreaterThan(ceiling * 0.9)
    }
  })

  it('the whole built-in registry stays under its total ceiling', () => {
    // TASKS.md #172: db_execute_sql and python_run both gained a few words of real guidance
    // (file-export behavior for a large result; read handoff files via real file I/O) — 8900 -> 8942
    // measured. Deliberate growth, not drift.
    const total = registry.list().reduce((n, t) => n + tokensFor(t), 0)
    // 2026-10-09: get_environment added (~27 tokens) - 9950 -> 9990. Deliberate.
    // 2026-10-10: api_create_connection gained `apiKeyIn` (NewsAPI.ai only reads its key from the URL query; the Configurator had no way to say so) - 9990 -> 10000. Deliberate.
    // 2026-10-12: mcp_list_connections now reports each connected server's actual tool names, not just a
    // count (TASKS #202 follow-up: fixes a 20-call loop found live) - 10000 -> 10009. Deliberate.
    expect(total).toBeLessThanOrEqual(10009)
  })
})
