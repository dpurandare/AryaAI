import type { McpServerStatus } from '@shared/ipc-contract'
import type { ToolRegistry } from '../tools/registry'
import { connectMcpServer } from './client'
import { getServerToken, listServerConfigs, type McpServerConfig } from './config'
import type { Client } from '@modelcontextprotocol/sdk/client'

interface ManagedServer {
  status: McpServerStatus
  error?: string
  toolNames: string[]
  client?: Client
}

export interface McpServerStatusInfo {
  status: McpServerStatus
  error?: string
  toolCount: number
}

/**
 * Owns the live state config.ts doesn't: connected clients, per-server
 * status, and which registry entries came from which server so they can be
 * cleanly unregistered on delete/reconnect. MCP tools land in the *same*
 * ToolRegistry the built-in tools live in (TASKS.md #45's "merged into the
 * agent tool registry") — the top-level Orchestrator's existing
 * `toolRegistry.list()` call picks them up automatically, no per-role
 * wiring needed.
 */
export class McpManager {
  private readonly servers = new Map<string, ManagedServer>()

  async connectAll(registry: ToolRegistry): Promise<void> {
    await Promise.all(listServerConfigs().map((config) => this.connect(config, registry)))
  }

  async reconnect(id: string, registry: ToolRegistry): Promise<void> {
    this.disconnect(id, registry)
    const config = listServerConfigs().find((c) => c.id === id)
    if (config) await this.connect(config, registry)
  }

  disconnect(id: string, registry: ToolRegistry): void {
    const managed = this.servers.get(id)
    if (!managed) return
    for (const name of managed.toolNames) registry.unregister(name)
    managed.client?.close().catch(() => {})
    this.servers.delete(id)
  }

  getStatus(id: string): McpServerStatusInfo | undefined {
    const managed = this.servers.get(id)
    if (!managed) return undefined
    return { status: managed.status, error: managed.error, toolCount: managed.toolNames.length }
  }

  private async connect(config: McpServerConfig, registry: ToolRegistry): Promise<void> {
    this.servers.set(config.id, { status: 'connecting', toolNames: [] })
    try {
      const token = config.transport === 'http' ? getServerToken(config.id) : undefined
      const { client, tools } = await connectMcpServer(config, token)
      for (const tool of tools) registry.register(tool)
      this.servers.set(config.id, { status: 'connected', toolNames: tools.map((t) => t.name), client })
    } catch (err) {
      this.servers.set(config.id, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        toolNames: []
      })
    }
  }
}
