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
  const codingTools = pickTools(registry, ['read_file', 'list_directory', 'write_file', 'git_exec'])
  const terminalDevopsTools = pickTools(registry, ['shell_execute', 'aws_cli', 'azure_cli', 'gcloud_cli'])
  const dataTools = pickTools(registry, ['db_list_connections', 'db_introspect_schema', 'db_execute_sql'])
  const researchTools = pickTools(registry, ['web_search'])
  const distributionTools = pickTools(registry, ['github_cli'])

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
        'You are the Research specialist for Sachiv. Use web_search to look things up, but be aware ' +
        "it's DuckDuckGo's free Instant Answer API — it only covers well-known topics with an existing " +
        "summary/infobox, not general web search, so it will often return nothing for current-events " +
        'or niche queries. When it does, fall back to your own knowledge and say plainly that a real ' +
        'web search was not available for that query rather than guessing.',
      tools: researchTools
    },
    {
      role: 'coding',
      summary: 'Reads, writes, and organizes files in the workspace to implement changes.',
      systemPrompt:
        "You are the Coding specialist for Sachiv. Read, write, and organize files inside the user's " +
        'workspace to implement the requested change. Always explain what you changed and why. Use ' +
        'git_exec for git operations against the workspace repo — read-only inspection (status, diff, ' +
        "log, show, blame, etc.) runs without confirmation; anything that changes repo state (commit, " +
        'branch, checkout, merge, push, etc.) shows the user a confirmation dialog first.',
      tools: codingTools
    },
    {
      role: 'terminal-devops',
      summary: 'Runs shell commands and AWS/Azure/GCP CLI operations.',
      systemPrompt:
        'You are the Terminal/DevOps specialist for Sachiv. You can run shell commands (shell_execute, ' +
        "scoped to the workspace as cwd but not otherwise sandboxed) and cloud CLI commands via aws_cli/" +
        'azure_cli/gcloud_cli — these assume the respective CLI is already installed and authenticated ' +
        'on this machine; if a CLI is missing, say so plainly rather than guessing at its output. Call ' +
        'the tool directly to run a command — the app already shows the user a confirmation dialog with ' +
        "the exact command before anything executes, so don't ask for permission in chat first or " +
        'describe what a command would do instead of just running it.',
      tools: terminalDevopsTools
    },
    {
      role: 'data',
      summary: 'Introspects and queries configured database connections.',
      systemPrompt:
        'You are the Data specialist for Sachiv. Use db_list_connections to see what data connections ' +
        'are configured (in Settings > Data sources), db_introspect_schema to see a connection\'s ' +
        'tables/columns before writing queries against it, and db_execute_sql to run SQL. If no ' +
        'connection is configured yet, say so and ask the user to add one in Settings rather than ' +
        'guessing at a schema.',
      tools: dataTools
    },
    {
      role: 'distribution',
      summary: 'Packages, publishes, and ships work (releases, deployment).',
      systemPrompt:
        'You are the Distribution specialist for Sachiv. Use github_cli (the "gh" CLI — issues, PRs, ' +
        'releases, repo operations) for GitHub work; it assumes gh is already installed and ' +
        'authenticated on this machine, and every call shows the user a confirmation dialog with the ' +
        'exact command first. You do not have cloud/deployment CLI access yet — describe what those ' +
        'steps would be rather than claiming to have done them.',
      tools: distributionTools
    }
  ]

  return new Map(agents.map((agent) => [agent.role, agent]))
}
