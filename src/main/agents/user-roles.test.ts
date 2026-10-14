import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Message } from '@shared/protocol'
import { validateRoleFile, type RoleFile } from '@shared/role-file'
import { ROLE_MANIFEST } from '@shared/agents'
import { MockProvider, type ScriptedTurn } from '../../../test/support/mock-provider'
import { WorkspaceGuard } from '../security/workspace-guard'
import { ToolRegistry } from '../tools/registry'
import type { Tool, ToolContext } from '../tools/types'
import { buildCapabilities } from './capabilities'
import { Orchestrator, type ConfirmDecision, type OrchestratorEvent, type ToolConfirmRequest } from './orchestrator'
import { createAgents } from './roles'
import { selectRouterTools } from './router-tools'

const tool = (name: string, run: () => string = () => `${name} ran`): Tool => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: 'object', properties: {} },
  mutates: false,
  execute: async () => run()
})

function role(over: Partial<RoleFile> = {}): RoleFile {
  const r = validateRoleFile(
    `---\nid: sql-reporter\nname: SQL Reporter\nsummary: Runs read-only SQL and formats a summary. Does not write data (Data Access does).\nexamples: ["Revenue by region", "Orders today"]\nnotExamples: ["Update the customer table"]\ntools: [reporting_query, "report_*"]\n---\nYou report on data. Read only.`,
    { siblings: ROLE_MANIFEST }
  ).role!
  return { ...r, ...over }
}

async function collect(o: Orchestrator, conversation: Message[], forced?: string | null): Promise<OrchestratorEvent[]> {
  const out: OrchestratorEvent[] = []
  for await (const e of o.run(conversation, forced)) out.push(e)
  return out
}
const autoApprove = () => async (r: ToolConfirmRequest): Promise<ConfirmDecision> => ({ approved: true, input: r.input })

describe('createAgents with user-defined roles', () => {
  it('appends them after the built-ins, marked custom, with their own label, flags and metadata', () => {
    const agents = createAgents(new ToolRegistry(), [role()])
    const keys = [...agents.keys()]
    expect(keys.at(-1)).toBe('sql-reporter')
    expect(keys.slice(0, ROLE_MANIFEST.length)).toEqual(ROLE_MANIFEST.map((r) => r.id))
    const a = agents.get('sql-reporter')!
    expect(a).toMatchObject({ custom: true, label: 'SQL Reporter', pickable: true, plannable: true })
    expect(a.meta?.examples).toHaveLength(2)
  })

  it('resolves tools by exact name and by prefix, LIVE — a tool registered after creation is picked up, one removed disappears', () => {
    const registry = new ToolRegistry()
    registry.register(tool('reporting_query'))
    const a = createAgents(registry, [role()]).get('sql-reporter')!
    expect(a.tools.map((t) => t.name)).toEqual(['reporting_query'])
    registry.register(tool('report_monthly'))
    registry.register(tool('unrelated'))
    expect(a.tools.map((t) => t.name)).toEqual(['reporting_query', 'report_monthly'])
    registry.unregister('reporting_query')
    expect(a.tools.map((t) => t.name)).toEqual(['report_monthly'])
  })

  it('a name matched by two patterns is listed once; an unknown tool name is simply absent (a disconnected MCP server is not an error)', () => {
    const registry = new ToolRegistry()
    registry.register(tool('report_a'))
    const a = createAgents(registry, [role({ tools: ['report_a', 'report_*', 'not_installed'] })]).get('sql-reporter')!
    expect(a.tools.map((t) => t.name)).toEqual(['report_a'])
  })

  it('gets the same completeness and handoff notes as the built-ins, after the user\'s own prompt', () => {
    const p = createAgents(new ToolRegistry(), [role()]).get('sql-reporter')!.systemPrompt
    expect(p.startsWith('You report on data. Read only.')).toBe(true)
    expect(p).toContain("don't silently stop as if the whole request is done")
    expect(p).toContain('[handoff: out_of_scope')
  })

  it('carries maxRounds and isolated through', () => {
    const a = createAgents(new ToolRegistry(), [role({ maxRounds: 4, isolated: true })]).get('sql-reporter')!
    expect(a).toMatchObject({ maxRounds: 4, isolated: true })
  })

  it('is extend-only even if a loader let one through: a user role with a built-in id never replaces the built-in', () => {
    const agents = createAgents(new ToolRegistry(), [role({ id: 'coding', name: 'Hijack' })])
    expect(agents.get('coding')?.custom).toBeUndefined()
    expect(agents.get('coding')?.label).toBeUndefined()
    expect(agents.size).toBe(ROLE_MANIFEST.length)
  })

  it('with no user roles the result is exactly the built-ins (nothing changes for anyone who never adds a role)', () => {
    expect([...createAgents(new ToolRegistry(), []).keys()]).toEqual(ROLE_MANIFEST.map((r) => r.id))
  })
})

describe('user-defined roles in the slim router and in capabilities', () => {
  it('a user role naming a router-only tool does not make the slim router drop it (custom roles never own tools)', () => {
    const registry = new ToolRegistry()
    for (const n of ['pptx_add_slide', 'shell_execute']) registry.register(tool(n))
    const agents = createAgents(registry, [role({ tools: ['pptx_add_slide'] })])
    expect(selectRouterTools(registry.list(), agents).map((t) => t.name)).toContain('pptx_add_slide')
  })

  it('describe_capabilities lists a user role, marked as the user\'s own, with its tools', () => {
    const registry = new ToolRegistry()
    registry.register(tool('reporting_query'))
    const agents = createAgents(registry, [role()])
    const text = buildCapabilities({ agents, registry, connections: { databases: [], apis: [], email: [] }, runtime: undefined, workspaceRoot: '/w' })
    expect(text).toMatch(/SQL Reporter \[your role\] \(delegate_to_sql_reporter\).*Tools: reporting_query/)
  })
})

describe('user-defined roles through the orchestrator', () => {
  let root: string
  let ctx: ToolContext
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-userrole-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 't' }
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function make(turns: ScriptedTurn[], files: RoleFile[] = [role()], planning = false) {
    const registry = new ToolRegistry()
    registry.register(tool('reporting_query', () => 'Q1 revenue: 100'))
    const provider = new MockProvider(turns)
    const orchestrator = new Orchestrator(provider, 'm', createAgents(registry, files), 'You are Sachivji.', registry.list(), autoApprove(), ctx, new AbortController().signal, { planningEnabled: planning })
    return { provider, orchestrator }
  }
  const asUser = (text: string): Message[] => [{ role: 'user', content: [{ type: 'text', text }] }]

  it('the router gets a delegate tool for it, described with the role\'s label and summary', async () => {
    const { provider, orchestrator } = make([{ text: 'hi', stopReason: 'end_turn' }])
    await collect(orchestrator, asUser('hi'))
    const d = provider.requests[0].tools?.find((t) => t.name === 'delegate_to_sql_reporter')
    expect(d?.description).toBe('Hand off to the SQL Reporter specialist: Runs read-only SQL and formats a summary. Does not write data (Data Access does).')
  })

  it('delegating to it runs its own prompt and its own tools, and the chip is tagged with its id', async () => {
    const { provider, orchestrator } = make([
      { toolCalls: [{ id: 'd', name: 'delegate_to_sql_reporter', input: { task: 'Q1 revenue' } }] },
      { toolCalls: [{ id: 'q', name: 'reporting_query', input: {} }] },
      { text: 'Q1 revenue is 100.', stopReason: 'end_turn' },
      { text: 'Done: Q1 revenue is 100.', stopReason: 'end_turn' }
    ])
    const events = await collect(orchestrator, asUser('what was Q1 revenue?'))
    expect(provider.requests[1].system).toContain('You report on data. Read only.')
    expect(provider.requests[1].tools?.map((t) => t.name)).toEqual(['reporting_query'])
    const toolStart = events.flatMap((e) => (e.kind === 'stream' && e.event.type === 'tool_use_start' && e.event.name === 'reporting_query' ? [e.event] : []))[0]
    expect(toolStart.agentRole).toBe('sql-reporter')
  })

  it('a plan may target a plannable user role, labelled with its own name — and the classifier is shown it', async () => {
    const { provider, orchestrator } = make(
      [
        { text: JSON.stringify({ complexity: 'compound', steps: [{ role: 'sql-reporter', description: 'get Q1 revenue' }, { role: 'research', description: 'find a caption' }] }), stopReason: 'end_turn' },
        { text: 'Revenue 100.', stopReason: 'end_turn' },
        { text: 'A caption.', stopReason: 'end_turn' },
        { text: 'All done.', stopReason: 'end_turn' }
      ],
      [role()],
      true
    )
    const events = await collect(orchestrator, asUser('get Q1 revenue and find a caption for the chart'))
    expect(provider.requests[0].system).toMatch(/- sql-reporter: Runs read-only SQL/)
    const texts = events.filter((e) => e.kind === 'message' && e.role === 'user').flatMap((e) => (e.kind === 'message' ? e.content : [])).flatMap((c) => (c.type === 'text' ? [c.text] : []))
    expect(texts.some((t) => t.startsWith('[Plan step 1 — SQL Reporter]'))).toBe(true)
    expect(texts.some((t) => t.includes('Revenue 100.'))).toBe(true)
  })

  it('a plan step naming a NON-plannable user role invalidates the plan, exactly as it does for page-creator', async () => {
    const { provider, orchestrator } = make(
      [
        { text: JSON.stringify({ complexity: 'compound', steps: [{ role: 'sql-reporter', description: 'a' }, { role: 'research', description: 'b' }] }), stopReason: 'end_turn' },
        { text: 'Answered normally.', stopReason: 'end_turn' }
      ],
      [role({ plannable: false })],
      true
    )
    await collect(orchestrator, asUser('do a and b'))
    expect(provider.requests[0].system).not.toMatch(/- sql-reporter:/) // not offered to the classifier...
    expect(provider.requests).toHaveLength(2) // ...and the unusable plan fell open to a normal single round
  })

  it('a pinned user role runs directly, and a pin on one that is gone falls back to Auto with a notice', async () => {
    const pinned = make([{ text: 'Reporting.', stopReason: 'end_turn' }])
    await collect(pinned.orchestrator, asUser('hi'), 'sql-reporter')
    expect(pinned.provider.requests[0].system).toContain('You report on data. Read only.')
    expect(pinned.provider.requests[0].tools?.some((t) => t.name.startsWith('delegate_to_'))).toBe(false)

    const gone = make([{ text: 'Auto reply.', stopReason: 'end_turn' }], [])
    const events = await collect(gone.orchestrator, asUser('hi'), 'sql-reporter')
    const warning = events.find((e) => e.kind === 'stream' && e.event.type === 'warning')
    expect(warning && warning.kind === 'stream' && warning.event.type === 'warning' ? warning.event.message : '').toMatch(/pinned "Sql Reporter" agent is not available/)
  })
})
