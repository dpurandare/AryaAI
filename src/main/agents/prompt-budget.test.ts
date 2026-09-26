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

const { createDefaultRegistry } = await import('../tools/setup')
const { createAgents } = await import('./roles')
const { Orchestrator } = await import('./orchestrator')
const { SYSTEM_PROMPT } = await import('./system-prompt')
const { createDescribeCapabilitiesTool } = await import('./capabilities')

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
 * Measured 2026-09-26 at step 1 (tiktoken o200k_base): routerPrompt 1228, routerToolSchemas 9391 (built-in tools + describe_capabilities +
 * 8 delegate tools), classify 778, roles 59 / 2803 / 3808 / 755 / 2982 / 241 / 795 / 535. Ceilings sit ~2% above. Lower them as later steps land.
 * Print the live numbers with `PRINT_BUDGET=1 npx vitest run src/main/agents/prompt-budget`.
 */
const CEILINGS = {
  routerPrompt: 1250,
  routerToolSchemas: 9600,
  routerBare: 10850,
  classifyPrompt: 800,
  'role:planning': 65,
  'role:research': 2850,
  'role:coding': 3900,
  'role:terminal-devops': 780,
  'role:data': 3050,
  'role:distribution': 250,
  'role:page-creator': 820,
  'role:email': 550
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
  const result: Record<string, number> = {
    routerPrompt,
    routerToolSchemas,
    routerBare: routerPrompt + routerToolSchemas,
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

  it('every role in the manifest is measured', () => {
    expect(Object.keys(measured).filter((k) => k.startsWith('role:')).length).toBe(8)
  })
})
