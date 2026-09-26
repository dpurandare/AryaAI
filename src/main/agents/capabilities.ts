import type { RuntimeState } from '@shared/runtime'
import type { AgentRole } from '@shared/agents'
import { roleMeta } from '@shared/agents'
import type { ToolRegistry } from '../tools/registry'
import type { Tool } from '../tools/types'
import type { Agent } from './orchestrator'

/**
 * `describe_capabilities` (design-discussion.md 3.5): what Sachivji can do
 * right now, generated from the same records the app actually runs on — the
 * role manifest, the live tool registry, the configured connections and the
 * Python runtime state — instead of from a model's memory. Found live: asked
 * "List all tools available to you", a session answered "I don't have the
 * necessary tools" (a weak model copying its own earlier refusal), and in the
 * Northwind sessions the assistant told the user it "cannot execute code"
 * while holding `shell_execute`. A tool that reports the truth removes the
 * guess.
 *
 * `buildCapabilities` is pure (all inputs injected) so it is unit-testable and
 * so a fixed, model-free "Capabilities" command can reuse it later if the
 * tool alone proves unreliable with weak models.
 */
export interface CapabilitiesInput {
  agents: ReadonlyMap<AgentRole, Agent>
  /** The full registry: what the top-level assistant can call directly. */
  registry: Pick<ToolRegistry, 'list'>
  connections: {
    databases: Array<{ name: string; engine: string }>
    apis: Array<{ name: string; baseUrl: string }>
    email: Array<{ name: string; emailAddress: string; isDefault: boolean }>
  }
  /** `null`/`undefined` while the runtime has not reported yet. */
  runtime: RuntimeState | null | undefined
  workspaceRoot: string
}

const DELEGATE_PREFIX = 'delegate_to_'

function isMcp(tool: Tool): boolean {
  return tool.name.startsWith('mcp__')
}

function mcpServerOf(tool: Tool): string {
  return tool.name.split('__')[1] ?? 'unknown'
}

function delegateName(role: string): string {
  return DELEGATE_PREFIX + role.replace(/-/g, '_')
}

function list(items: string[]): string {
  return items.length ? items.join(', ') : 'none'
}

function runtimeLine(runtime: RuntimeState | null | undefined, root: string): string {
  const venv = `${root}/venv`
  if (!runtime) return 'Python: status not reported yet.'
  switch (runtime.status) {
    case 'ready':
      return (
        `Python: AVAILABLE${runtime.pythonVersion ? ` (${runtime.pythonVersion})` : ''}. Scripts run through shell_execute ` +
        `with the workspace virtual environment (${venv}) already active, so plain \`python\` and \`pip\` resolve to it` +
        (runtime.packages === 'installing' ? ' (base packages are still installing)' : '') +
        '. You CAN write a script and run it; each shell command asks the user for confirmation.'
      )
    case 'creating':
      return 'Python: being set up right now — try again in a minute.'
    case 'disabled':
      return 'Python: turned off by the user (Settings > Runtime). Do not offer to run scripts; tell them they can turn it back on there.'
    case 'missing-python':
      return `Python: NOT available — ${runtime.message}`
    case 'failed':
      return `Python: NOT available — ${runtime.message}`
  }
}

export function buildCapabilities(input: CapabilitiesInput): string {
  const { agents, registry, connections, runtime, workspaceRoot } = input
  const tools = registry.list()
  const out: string[] = []

  out.push('# What Sachivji can do right now')
  out.push(
    'You can call the tools listed under "Tools you can call directly", or hand a step to a specialist with its delegate tool. ' +
      'Answer capability questions from this list, not from memory.'
  )

  out.push('\n## Specialists')
  for (const agent of agents.values()) {
    const meta = roleMeta(agent.role)
    const own = agent.tools.filter((t) => !isMcp(t)).map((t) => t.name)
    const mcpCount = agent.tools.filter(isMcp).length
    const toolText = own.length === 0 && mcpCount === 0 ? 'no tools (reasoning only)' : list(own) + (mcpCount ? `${own.length ? ', plus ' : ''}${mcpCount} MCP tools` : '')
    out.push(`- ${meta?.label ?? agent.role} (${delegateName(agent.role)}): ${meta?.description ?? agent.summary} Tools: ${toolText}.`)
  }

  const direct = tools.filter((t) => !isMcp(t)).map((t) => t.name)
  out.push('\n## Tools you can call directly')
  out.push(list(direct) + '.')

  out.push('\n## Connections')
  out.push(
    connections.databases.length
      ? `Databases: ${connections.databases.map((d) => `${d.name} (${d.engine})`).join(', ')}.`
      : 'Databases: none configured — the Data specialist cannot query anything until one is added in Settings > Data sources.'
  )
  out.push(
    connections.apis.length
      ? `External APIs: ${connections.apis.map((a) => `${a.name} (${a.baseUrl})`).join(', ')}.`
      : 'External APIs: none configured (Settings > External APIs).'
  )
  out.push(
    connections.email.length
      ? `Email accounts: ${connections.email.map((e) => `${e.name} <${e.emailAddress}>${e.isDefault ? ' [default]' : ''}`).join(', ')}.`
      : 'Email accounts: none configured — sending email is not possible until one is added in Settings.'
  )
  const mcpByServer = new Map<string, number>()
  for (const t of tools.filter(isMcp)) mcpByServer.set(mcpServerOf(t), (mcpByServer.get(mcpServerOf(t)) ?? 0) + 1)
  out.push(
    mcpByServer.size
      ? `MCP servers connected: ${[...mcpByServer].map(([s, n]) => `${s} (${n} tools, named mcp__${s}__*)`).join(', ')}.`
      : 'MCP servers connected: none.'
  )

  out.push('\n## Running code')
  out.push(runtimeLine(runtime, workspaceRoot))
  out.push('The shell runs with the workspace as its working directory but is not a sandbox — it can read and write anywhere the user can.')

  out.push('\n## Limits')
  const alwaysConfirm = tools.filter((t) => t.mutates === true).map((t) => t.name)
  const sometimesConfirm = tools.filter((t) => typeof t.mutates === 'function').map((t) => t.name)
  out.push(`Asks the user to confirm before running: ${list(alwaysConfirm)}.`)
  if (sometimesConfirm.length) out.push(`Asks only when the call would change something: ${list(sometimesConfirm)}.`)
  out.push(`File tools are confined to the workspace folder: ${workspaceRoot}.`)

  return out.join('\n')
}

export interface DescribeCapabilitiesDeps {
  getAgents(): ReadonlyMap<AgentRole, Agent>
  getRegistry(): Pick<ToolRegistry, 'list'>
  getConnections(): CapabilitiesInput['connections']
  getRuntime(): RuntimeState | null | undefined
}

export function createDescribeCapabilitiesTool(deps: DescribeCapabilitiesDeps): Tool {
  return {
    name: 'describe_capabilities',
    description:
      'Lists what Sachivji can do right now: the specialists and their tools, configured databases / APIs / email accounts / MCP servers, ' +
      'whether Python scripts can be run, and which actions ask for confirmation. Call this whenever the user asks what you can do, ' +
      'what tools you have, or whether you can do something — do not answer from memory, and never say you lack tools without checking.',
    inputSchema: { type: 'object', properties: {} },
    mutates: false,
    async execute(_input, ctx) {
      return buildCapabilities({
        agents: deps.getAgents(),
        registry: deps.getRegistry(),
        connections: deps.getConnections(),
        runtime: deps.getRuntime(),
        workspaceRoot: ctx.workspaceGuard.root
      })
    }
  }
}
