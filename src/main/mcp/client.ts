import type { ToolDefinition } from '../providers/types'

export type McpServerConfig =
  | { transport: 'stdio'; id: string; command: string; args?: string[] }
  | { transport: 'http'; id: string; url: string; headers?: Record<string, string> }

export interface McpClient {
  readonly serverId: string
  connect(): Promise<void>
  disconnect(): Promise<void>
  listTools(): Promise<ToolDefinition[]>
  callTool(name: string, input: Record<string, unknown>): Promise<unknown>
}

// TODO: implement StdioMcpClient (child_process + JSON-RPC over stdio) and
// HttpMcpClient (HTTP POST + SSE stream) against the MCP spec.
export function createMcpClient(_config: McpServerConfig): McpClient {
  throw new Error('MCP client not yet implemented')
}
