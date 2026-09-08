import { Client } from '@modelcontextprotocol/sdk/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Tool, ToolContext } from '../tools/types'
import type { McpServerConfig } from './config'

function buildTransport(config: McpServerConfig, token: string | undefined): Transport {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command ?? '',
      args: config.args,
      // Merge onto the SDK's own filtered-safe default env rather than
      // replacing it — otherwise one custom var would drop PATH etc. and
      // break resolving `command` at all.
      env: config.env ? { ...getDefaultEnvironment(), ...config.env } : undefined
    })
  }
  return new StreamableHTTPClientTransport(new URL(config.url ?? ''), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
  })
}

/** MCP tool content can include non-text parts; nothing in the app renders those yet, so they're summarized rather than dropped silently. */
function contentToText(content: unknown[]): string {
  return content
    .map((block) => {
      const b = block as { type?: unknown; text?: unknown }
      return typeof b.type === 'string' && b.type === 'text' && typeof b.text === 'string'
        ? b.text
        : `[${String(b.type)} content omitted]`
    })
    .join('\n')
}

function wrapMcpTool(
  client: Client,
  serverName: string,
  mcpTool: {
    name: string
    description?: string
    inputSchema: Record<string, unknown>
    annotations?: { readOnlyHint?: boolean }
  }
): Tool {
  return {
    name: `mcp__${serverName}__${mcpTool.name}`,
    description: mcpTool.description ?? `Tool "${mcpTool.name}" from MCP server "${serverName}".`,
    inputSchema: mcpTool.inputSchema,
    // `readOnlyHint` is a hint the server itself provides, not a guarantee —
    // the MCP spec says clients must not treat it as a security boundary.
    // Trusted in one direction only: an explicit true skips confirmation;
    // anything else (false, or simply absent) defaults to requiring it —
    // same "default to the safe direction" principle as git_exec/db_execute_sql.
    mutates: mcpTool.annotations?.readOnlyHint !== true,
    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
      const result = await client.callTool({ name: mcpTool.name, arguments: input })
      if ('content' in result) {
        const text = contentToText(result.content as unknown[])
        if (result.isError) throw new Error(text || `MCP tool "${mcpTool.name}" reported an error.`)
        return text
      }
      return JSON.stringify(result.toolResult)
    }
  }
}

export async function connectMcpServer(
  config: McpServerConfig,
  token: string | undefined
): Promise<{ client: Client; tools: Tool[] }> {
  const client = new Client({ name: 'sachiv', version: '0.1.0' })
  const transport = buildTransport(config, token)
  await client.connect(transport)

  const { tools: mcpTools } = await client.listTools()
  const tools = mcpTools.map((mcpTool) => wrapMcpTool(client, config.name, mcpTool))

  return { client, tools }
}
