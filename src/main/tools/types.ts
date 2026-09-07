/**
 * A Tool is what agents call. `mutates: true` tools must go through the
 * human-in-loop confirmation flow unless the user has configured auto-approve
 * for that tool within the current workspace boundary.
 */
export interface Tool<Input = Record<string, unknown>, Output = unknown> {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mutates: boolean
  run(input: Input, context: ToolContext): Promise<Output>
}

export interface ToolContext {
  workspaceRoot: string
  sessionId: string
  signal: AbortSignal
}
