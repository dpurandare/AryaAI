import type { AgentRole } from '@shared/agents'
import type { ToolRegistry } from '../tools/registry'
import type { Tool } from '../tools/types'
import type { Agent } from './orchestrator'

/**
 * The 6 specialist roles per TASKS.md #28. Only `coding` has real tools
 * today (file-ops, pulled from the shared registry) — the rest are
 * reasoning-only until their tools land later in the work order (TASKS.md
 * "Widen tools", step 9). Their prompts say so explicitly rather than
 * letting the model imply a capability it doesn't have.
 */
export function createAgents(registry: ToolRegistry): Map<AgentRole, Agent> {
  const codingTools: Tool[] = ['read_file', 'list_directory', 'write_file']
    .map((name) => registry.get(name))
    .filter((tool): tool is Tool => tool !== undefined)

  const agents: Agent[] = [
    {
      role: 'planning',
      summary: 'Breaks a complex or ambiguous request into a clear, ordered set of concrete steps.',
      systemPrompt:
        'You are the Planning specialist for Sachiv, a local-first AI assistant. Break the request ' +
        'down into a clear, ordered, actionable plan. You have no tools of your own yet — produce the ' +
        "plan as text for the user or another specialist to follow; don't claim to execute anything yourself.",
      tools: []
    },
    {
      role: 'research',
      summary: 'Gathers and synthesizes information relevant to the request.',
      systemPrompt:
        'You are the Research specialist for Sachiv. Gather and synthesize information relevant to the ' +
        'request and present clear findings. You do not have live web search yet — rely on your own ' +
        'knowledge, and clearly flag anything that would need an external lookup once a search tool is available.',
      tools: []
    },
    {
      role: 'coding',
      summary: 'Reads, writes, and organizes files in the workspace to implement changes.',
      systemPrompt:
        "You are the Coding specialist for Sachiv. Read, write, and organize files inside the user's " +
        'workspace to implement the requested change. Always explain what you changed and why.',
      tools: codingTools
    },
    {
      role: 'terminal-devops',
      summary: 'Runs shell/terminal commands and DevOps tasks.',
      systemPrompt:
        'You are the Terminal/DevOps specialist for Sachiv. You do not have shell execution access yet ' +
        '— explain what commands would need to run and why, rather than claiming to have run them.',
      tools: []
    },
    {
      role: 'data',
      summary: 'Accesses and analyzes data sources such as databases.',
      systemPrompt:
        'You are the Data specialist for Sachiv. You do not have database access yet — describe what ' +
        'data or queries would be needed rather than claiming to have run them.',
      tools: []
    },
    {
      role: 'distribution',
      summary: 'Packages, publishes, and ships work (releases, deployment).',
      systemPrompt:
        'You are the Distribution specialist for Sachiv. You do not have cloud/deployment CLI access ' +
        'yet — describe what publishing or deployment steps would be needed rather than claiming to have done them.',
      tools: []
    }
  ]

  return new Map(agents.map((agent) => [agent.role, agent]))
}
