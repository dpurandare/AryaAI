import { randomUUID } from 'node:crypto'
import type { McpTransport, SaveMcpServerInput } from '@shared/ipc-contract'
import { listServerConfigs, saveServerConfig, type McpServerConfig } from '../../mcp/config'
import { connectMcpServer } from '../../mcp/client'
import type { Tool } from '../types'

function configFromInput(input: Record<string, unknown>, id: string): McpServerConfig {
  const transport = String(input.transport ?? '') as McpTransport
  if (transport === 'stdio') {
    return {
      id,
      name: String(input.name ?? ''),
      transport: 'stdio',
      command: String(input.command ?? ''),
      args: Array.isArray(input.args) ? input.args.map(String) : [],
      description: typeof input.description === 'string' ? input.description : undefined
    }
  }
  return { id, name: String(input.name ?? ''), transport: 'http', url: String(input.url ?? ''), description: typeof input.description === 'string' ? input.description : undefined }
}

/** Connects for real (the same handshake McpManager uses live) then immediately closes — a probe, not a lasting connection; the real one is established afterward by ctx.connectMcpServer once the config is actually saved. */
async function probeConnection(input: Record<string, unknown>): Promise<void> {
  const transport = String(input.transport ?? '')
  if (transport !== 'stdio' && transport !== 'http') {
    throw new Error(`transport must be "stdio" or "http" (got "${transport}").`)
  }
  const config = configFromInput(input, randomUUID())
  const token = transport === 'http' && typeof input.token === 'string' ? input.token : undefined
  const { client } = await connectMcpServer(config, token)
  await client.close()
}

export const mcpCreateConnectionTool: Tool = {
  name: 'mcp_create_connection',
  description:
    'Configure a new MCP server (Settings > MCP servers) directly from details gathered in chat. Gather ' +
    "the non-secret fields yourself (name, transport, command/args for stdio, or url for http); an http " +
    "server's bearer token is entered by the user directly in the confirmation dialog, never typed to " +
    "you — never ask the user to tell you a token in chat. The server is actually connected to (a real " +
    "handshake, listing its tools) before being saved, so a bad command/url/token is caught immediately. " +
    "Once saved, its tools are wired in live and usable right away, no restart needed.",
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Must be unique — doubles as the tool-name namespace for this server\'s tools' },
      transport: { type: 'string', enum: ['stdio', 'http'] },
      command: { type: 'string', description: 'stdio only' },
      args: { type: 'array', items: { type: 'string' }, description: 'stdio only' },
      url: { type: 'string', description: 'http only' },
      description: { type: 'string', description: 'One short line (max 200 chars) on what this server is for, e.g. "Energy-sector wiki: runbooks and maintenance guides". Shown to the assistant instead of the server\'s own text — write it from what the user told you.' },
      token: { type: 'string', description: 'http only — user enters this directly, do not ask for it in chat' }
    },
    required: ['name', 'transport']
  },
  mutates: true,
  secretFields: ['token'],
  describe(input) {
    const transport = String(input.transport ?? '')
    const target = transport === 'stdio' ? String(input.command ?? '') : String(input.url ?? '')
    return `Configure MCP server "${String(input.name ?? '')}" (${transport}) → ${target}`
  },
  validate: probeConnection,
  async execute(input, ctx) {
    const name = String(input.name ?? '')
    if (listServerConfigs().some((s) => s.name === name)) {
      throw new Error(`An MCP server named "${name}" already exists.`)
    }
    await probeConnection(input)
    const transport = String(input.transport ?? '') as McpTransport
    const description = typeof input.description === 'string' ? input.description : undefined
    const saveInput: SaveMcpServerInput =
      transport === 'stdio'
        ? {
            name,
            transport: 'stdio',
            command: String(input.command ?? ''),
            args: Array.isArray(input.args) ? input.args.map(String) : [],
            description
          }
        : { name, transport: 'http', url: String(input.url ?? ''), token: typeof input.token === 'string' ? input.token : undefined, description }

    const saved = saveServerConfig(saveInput)
    await ctx.connectMcpServer?.(saved.id)
    return `Configured and connected MCP server "${saved.name}". Its tools are already live and usable.`
  }
}
