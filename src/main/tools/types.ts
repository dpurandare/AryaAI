import type { WorkspaceGuard } from '../security/workspace-guard'

export interface ToolContext {
  workspaceGuard: WorkspaceGuard
}

/**
 * A tool the model can call. `mutates: true` routes every call through the
 * human-in-loop confirmation flow in ipc/register.ts before `execute` runs.
 */
export interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mutates: boolean
  /** Human-readable summary shown in the confirmation dialog. Defaults to the raw input JSON. */
  describe?(input: Record<string, unknown>): string
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string>
}
