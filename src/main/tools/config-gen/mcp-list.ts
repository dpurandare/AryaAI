import { listServerConfigs } from '../../mcp/config'
import type { Tool } from '../types'

/**
 * Read-only: the MCP servers configured in Settings > MCP servers, with each one's live connection state.
 * Reads the stored configs on every call (never a cached copy), so a server added or deleted a moment ago is
 * reflected immediately. Found live: with no listing tool, "which MCP servers are configured?" was answered
 * "none" from a stale history search, minutes after Context7 had been connected.
 *
 * Lists each connected server's actual tool names, not just a count — found live: asked "list the tools
 * available with the MCP Context7", the model had only a tool *count* here, so it called this same tool
 * 20 times in a row hoping for more detail that was never going to show up, then gave up with a vague
 * non-answer ("2 tools, named mcp__Context7__*") instead of naming them. The real tool definitions are
 * already in the caller's own tool list (registered straight into the shared `ToolRegistry`), so this
 * exists only because the model had no way to ask "what are server X's tools called" without re-deriving
 * it from this summary.
 */
export const mcpListConnectionsTool: Tool = {
  name: 'mcp_list_connections',
  description:
    'List configured MCP servers, live: name, what each is for, connected or failing (with error), and each ' +
    "connected server's actual tool names. Use for any \"which MCP servers\"/\"what tools does X have\" " +
    'question — never search_history, which is stale.',
  inputSchema: { type: 'object', properties: {} },
  mutates: false,
  async execute(_input, ctx) {
    const servers = listServerConfigs()
    if (!servers.length) return 'No MCP servers are configured. The user can add one in Settings > MCP servers.'
    return servers
      .map((s) => {
        const live = ctx.mcpServerStatus?.(s.id)
        const state = live
          ? live.status === 'connected'
            ? `connected, ${live.toolCount} tools: ${live.toolNames.join(', ')}`
            : live.status === 'error'
              ? `NOT connected — ${live.error ?? 'unknown error'}`
              : 'connecting'
          : 'status unknown'
        const target = s.transport === 'stdio' ? `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim() : (s.url ?? '')
        return `- "${s.name}" (${s.transport}: ${target})${s.description ? ` — ${s.description}` : ''}: ${state}`
      })
      .join('\n')
  }
}
