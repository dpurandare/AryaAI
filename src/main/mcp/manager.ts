import type { McpServerStatus } from '@shared/ipc-contract'
import type { ToolRegistry } from '../tools/registry'
import { connectMcpServer } from './client'
import { getServerToken, listServerConfigs, type McpServerConfig } from './config'
import type { Client } from '@modelcontextprotocol/sdk/client'

interface ManagedServer {
  status: McpServerStatus
  error?: string
  /** Full technical text for a collapsible area (set when the failure came with one). */
  errorDetail?: string
  toolNames: string[]
  client?: Client
}

export interface McpServerStatusInfo {
  status: McpServerStatus
  error?: string
  errorDetail?: string
  toolCount: number
  toolNames: string[]
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

  /** Connects every configured server that has no live entry yet (e.g. just added by a settings import, which only writes the config). */
  async connectMissing(registry: ToolRegistry): Promise<void> {
    await Promise.all(listServerConfigs().filter((c) => !this.servers.has(c.id)).map((c) => this.connect(c, registry)))
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

  /**
   * Closes every connected server's client — for a `stdio` server, this is
   * what actually kills its underlying child process (`StdioClientTransport`
   * closes the process's stdin, and well-behaved servers exit on stdin-end,
   * same as the manual `disconnect()` path above already relies on). Must be
   * called on app shutdown: found live, not assumed — with no shutdown hook
   * calling this, every quit or dev-mode main-process restart left each
   * `stdio` server's child process (e.g. `gbrain serve`) running as an
   * orphan, and a strict-single-writer server like gbrain's PGLite-backed
   * brain then refused the *next* launch's fresh connection outright
   * ("already open through gbrain serve (MCP, PID ...)"). Iterates a
   * snapshot of the ids (not the live Map) since `disconnect()` mutates
   * `this.servers` as it goes.
   */
  disconnectAll(registry: ToolRegistry): void {
    for (const id of [...this.servers.keys()]) this.disconnect(id, registry)
  }

  getStatus(id: string): McpServerStatusInfo | undefined {
    const managed = this.servers.get(id)
    if (!managed) return undefined
    return { status: managed.status, error: managed.error, errorDetail: managed.errorDetail, toolCount: managed.toolNames.length, toolNames: managed.toolNames }
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
        errorDetail: typeof (err as { detail?: unknown }).detail === 'string' ? (err as { detail: string }).detail : undefined,
        toolNames: []
      })
    }
  }
}
