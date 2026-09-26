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
const { ROUTER_CORE_TOKEN_CAP, ROUTER_CORE_TOOLS, selectRouterTools } = await import('./router-tools')

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
 * Print the live numbers with `PRINT_BUDGET=1 npx vitest run src/main/agents/prompt-budget`.
 */
const CEILINGS = {
  routerPrompt: 880,
  routerToolSchemas: 9900,
  routerBare: 10760,
  slimRouterToolSchemas: 2130,
  slimRouterBare: 3000,
  routerCore: 800,
  classifyPrompt: 910,
  'role:planning': 65,
  'role:research': 1340,
  'role:history-analyst': 500,
  'role:coding': 2500,
  'role:data': 2640,
  'role:data-processor': 1920,
  'role:document-creator': 1990,
  'role:configurator': 1290,
  'role:mcp-operator': 360,
  'role:page-creator': 820,
  'role:email': 630
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
    registry.list(),
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
  office_create_document: 590,
  parse_csv: 450,
  office_extract_template: 410,
  pptx_compose_slide: 400,
  xlsx_write: 365,
  api_call: 360,
  db_create_connection: 350,
  mcp_create_connection: 340,
  parse_html: 330
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
    const total = registry.list().reduce((n, t) => n + tokensFor(t), 0)
    expect(total).toBeLessThanOrEqual(8900) // 8,710 measured
  })
})
