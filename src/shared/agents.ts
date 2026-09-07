/**
 * Specialist agent roles the Orchestrator can hand a step off to. Lives in
 * shared/ (not main/agents/) because it crosses the IPC boundary — both the
 * main process (routing/execution) and the renderer (attributing streamed
 * content to the agent that produced it) need this type.
 */
export type AgentRole =
  | 'planning'
  | 'research'
  | 'coding'
  | 'terminal-devops'
  | 'data'
  | 'distribution'

export const AGENT_ROLES: readonly AgentRole[] = [
  'planning',
  'research',
  'coding',
  'terminal-devops',
  'data',
  'distribution'
]

/** Human-readable label per role — used by both the orchestrator's own system prompt and the renderer's mode picker/role chips, so the two stay in sync. */
export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  planning: 'Planning',
  research: 'Research',
  coding: 'Coding',
  'terminal-devops': 'Terminal/DevOps',
  data: 'Data',
  distribution: 'Distribution'
}
