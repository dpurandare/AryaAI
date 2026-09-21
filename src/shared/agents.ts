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
  | 'page-creator'

/**
 * The user-selectable/plannable roles — powers both the renderer's manual
 * Ctrl+Tab mode-picker cycle and the classify-and-plan step's set of valid
 * plan-step targets (orchestrator.ts's `VALID_STEP_ROLES`). Deliberately
 * does NOT include every value of `AgentRole`: `page-creator` (#78) is an
 * isolated, delegate-only specialist that expects a specific one-slide
 * brief, not a general chat turn — forcing a user conversation onto it
 * directly, or letting the classifier target it as a whole plan step,
 * would both be nonsensical. It still needs an `AgentRole` value (for
 * `Agent.role`/`dispatchDelegate`'s map key and role-chip labeling) and an
 * `AGENT_ROLE_LABELS` entry below — just not a slot here.
 */
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
  distribution: 'Distribution',
  'page-creator': 'Page Creator'
}
