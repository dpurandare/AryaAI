<script lang="ts">
  import type {
    DataConnectionDto,
    McpServerDto,
    McpTransport,
    ProviderDescriptor,
    ToolDescriptor
  } from '@shared/ipc-contract'

  let {
    providerDisplayName,
    providerRequiresApiKey = true,
    hasKey,
    autoApproveRules,
    providers,
    onSave,
    onClose,
    onToggleAutoApproveRule
  }: {
    providerDisplayName: string
    providerRequiresApiKey?: boolean
    hasKey: boolean
    autoApproveRules: Record<string, boolean>
    providers: ProviderDescriptor[]
    onSave: (apiKey: string) => void | Promise<void>
    onClose: () => void
    onToggleAutoApproveRule: (name: string, value: boolean) => void
  } = $props()

  let apiKey = $state('')
  let saving = $state(false)

  async function save(): Promise<void> {
    if (!apiKey.trim()) return
    saving = true
    await onSave(apiKey.trim())
    saving = false
  }

  // --- Data sources (db_* tools' connections — TASKS.md #35) ---
  let connections = $state<DataConnectionDto[]>([])
  let showAddConnection = $state(false)
  let connName = $state('')
  let connEngine = $state<'sqlite' | 'postgres'>('sqlite')
  let connFilePath = $state('')
  let connHost = $state('')
  let connPort = $state('5432')
  let connDatabase = $state('')
  let connUsername = $state('')
  let connPassword = $state('')
  let savingConnection = $state(false)

  async function loadConnections(): Promise<void> {
    connections = await window.sachiv.listDataConnections()
  }
  loadConnections()

  function resetConnectionForm(): void {
    connName = ''
    connEngine = 'sqlite'
    connFilePath = ''
    connHost = ''
    connPort = '5432'
    connDatabase = ''
    connUsername = ''
    connPassword = ''
    showAddConnection = false
  }

  async function saveConnection(): Promise<void> {
    if (!connName.trim()) return
    savingConnection = true
    try {
      await window.sachiv.saveDataConnection({
        name: connName.trim(),
        engine: connEngine,
        filePath: connEngine === 'sqlite' ? connFilePath.trim() : undefined,
        host: connEngine === 'postgres' ? connHost.trim() : undefined,
        port: connEngine === 'postgres' ? Number(connPort) || 5432 : undefined,
        database: connEngine === 'postgres' ? connDatabase.trim() : undefined,
        username: connEngine === 'postgres' ? connUsername.trim() : undefined,
        password: connEngine === 'postgres' && connPassword ? connPassword : undefined
      })
      resetConnectionForm()
      await loadConnections()
    } finally {
      savingConnection = false
    }
  }

  async function removeConnection(id: string): Promise<void> {
    await window.sachiv.deleteDataConnection(id)
    await loadConnections()
  }

  // --- MCP servers (TASKS.md #42-45) ---
  let mcpServers = $state<McpServerDto[]>([])
  let showAddMcpServer = $state(false)
  let mcpName = $state('')
  let mcpTransport = $state<McpTransport>('stdio')
  let mcpCommand = $state('')
  let mcpArgs = $state('')
  let mcpEnv = $state('')
  let mcpUrl = $state('')
  let mcpToken = $state('')
  let savingMcpServer = $state(false)
  let mcpError = $state('')

  async function loadMcpServers(): Promise<void> {
    mcpServers = await window.sachiv.listMcpServers()
  }
  loadMcpServers()

  function resetMcpForm(): void {
    mcpName = ''
    mcpTransport = 'stdio'
    mcpCommand = ''
    mcpArgs = ''
    mcpEnv = ''
    mcpUrl = ''
    mcpToken = ''
    mcpError = ''
    showAddMcpServer = false
  }

  /** One `KEY=VALUE` per line; blank/malformed lines are skipped rather than rejected. */
  function parseEnvLines(text: string): Record<string, string> | undefined {
    const entries = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf('=')
        return i > 0 ? ([line.slice(0, i).trim(), line.slice(i + 1).trim()] as const) : undefined
      })
      .filter((e): e is readonly [string, string] => e !== undefined)
    return entries.length ? Object.fromEntries(entries) : undefined
  }

  async function saveMcpServer(): Promise<void> {
    if (!mcpName.trim()) return
    savingMcpServer = true
    mcpError = ''
    try {
      await window.sachiv.saveMcpServer({
        name: mcpName.trim(),
        transport: mcpTransport,
        command: mcpTransport === 'stdio' ? mcpCommand.trim() : undefined,
        args: mcpTransport === 'stdio' ? mcpArgs.trim().split(/\s+/).filter(Boolean) : undefined,
        env: mcpTransport === 'stdio' ? parseEnvLines(mcpEnv) : undefined,
        url: mcpTransport === 'http' ? mcpUrl.trim() : undefined,
        token: mcpTransport === 'http' && mcpToken ? mcpToken : undefined
      })
      resetMcpForm()
      await loadMcpServers()
    } catch (err) {
      mcpError = err instanceof Error ? err.message : String(err)
    } finally {
      savingMcpServer = false
    }
  }

  async function removeMcpServer(id: string): Promise<void> {
    await window.sachiv.deleteMcpServer(id)
    await loadMcpServers()
  }

  async function reconnectMcpServer(id: string): Promise<void> {
    await window.sachiv.reconnectMcpServer(id)
    await loadMcpServers()
  }

  function mcpStatusLabel(server: McpServerDto): string {
    if (server.status === 'connecting') return 'Connecting...'
    if (server.status === 'error') return `Error: ${server.error ?? 'unknown'}`
    return `Connected · ${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`
  }

  // --- Workspace boundary (TASKS.md #41) ---
  let workspaceRoot = $state('')
  let workspaceRootInput = $state('')
  let savingWorkspace = $state(false)
  let workspaceError = $state('')

  async function loadWorkspaceRoot(): Promise<void> {
    workspaceRoot = await window.sachiv.getWorkspaceRoot()
    workspaceRootInput = workspaceRoot
  }
  loadWorkspaceRoot()

  async function saveWorkspaceRoot(): Promise<void> {
    if (!workspaceRootInput.trim() || workspaceRootInput === workspaceRoot) return
    savingWorkspace = true
    workspaceError = ''
    try {
      await window.sachiv.setWorkspaceRoot(workspaceRootInput.trim())
      await loadWorkspaceRoot()
    } catch (err) {
      workspaceError = err instanceof Error ? err.message : String(err)
    } finally {
      savingWorkspace = false
    }
  }

  // --- Search history / embedding provider (TASKS.md #52 — decoupled from the chat provider above) ---
  const EMBEDDING_PROVIDER_SETTING_KEY = 'embeddingProviderId'
  const EMBEDDING_MODEL_SETTING_KEY = 'embeddingModel'
  const DEFAULT_EMBEDDING_PROVIDER_ID = 'ollama'
  const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text'

  const embeddingCapableProviders = $derived(providers.filter((p) => p.supportsEmbeddings))

  let embeddingProviderId = $state(DEFAULT_EMBEDDING_PROVIDER_ID)
  let embeddingModel = $state(DEFAULT_EMBEDDING_MODEL)
  let embeddingHasKey = $state(false)
  let embeddingApiKey = $state('')
  let savingEmbeddingKey = $state(false)
  let searchHistoryStatus = $state<{
    state: 'empty' | 'ready' | 'needs-rebuild'
    indexed: number
    total: number
  } | null>(null)
  let rebuildingIndex = $state(false)

  async function loadEmbeddingConfig(): Promise<void> {
    embeddingProviderId = (await window.sachiv.getSetting(EMBEDDING_PROVIDER_SETTING_KEY)) ?? DEFAULT_EMBEDDING_PROVIDER_ID
    embeddingModel = (await window.sachiv.getSetting(EMBEDDING_MODEL_SETTING_KEY)) ?? DEFAULT_EMBEDDING_MODEL
    await refreshEmbeddingHasKey()
  }
  loadEmbeddingConfig()

  async function refreshEmbeddingHasKey(): Promise<void> {
    const descriptor = embeddingCapableProviders.find((p) => p.id === embeddingProviderId)
    embeddingHasKey = descriptor?.requiresApiKey === false ? true : await window.sachiv.hasApiKey(embeddingProviderId)
  }

  async function loadSearchHistoryStatus(): Promise<void> {
    searchHistoryStatus = await window.sachiv.getSearchHistoryStatus()
  }
  loadSearchHistoryStatus()

  async function changeEmbeddingProvider(id: string): Promise<void> {
    embeddingProviderId = id
    embeddingApiKey = ''
    await window.sachiv.setSetting(EMBEDDING_PROVIDER_SETTING_KEY, id)
    await refreshEmbeddingHasKey()
    await loadSearchHistoryStatus()
  }

  async function changeEmbeddingModel(): Promise<void> {
    if (!embeddingModel.trim()) return
    await window.sachiv.setSetting(EMBEDDING_MODEL_SETTING_KEY, embeddingModel.trim())
    await loadSearchHistoryStatus()
  }

  async function saveEmbeddingKey(): Promise<void> {
    if (!embeddingApiKey.trim()) return
    savingEmbeddingKey = true
    try {
      await window.sachiv.setApiKey(embeddingProviderId, embeddingApiKey.trim())
      embeddingApiKey = ''
      await refreshEmbeddingHasKey()
    } finally {
      savingEmbeddingKey = false
    }
  }

  async function rebuildSearchHistoryIndex(): Promise<void> {
    rebuildingIndex = true
    try {
      await window.sachiv.rebuildSearchHistoryIndex()
      await loadSearchHistoryStatus()
    } finally {
      rebuildingIndex = false
    }
  }

  function searchHistoryStatusLabel(): string {
    if (!searchHistoryStatus) return 'Loading...'
    if (searchHistoryStatus.state === 'needs-rebuild') {
      return 'Embedding model changed — index needs a rebuild before search works again.'
    }
    return `${searchHistoryStatus.indexed} / ${searchHistoryStatus.total} messages indexed`
  }

  // --- Auto-approve rules (TASKS.md #40) ---
  let tools = $state<ToolDescriptor[]>([])

  async function loadTools(): Promise<void> {
    tools = await window.sachiv.listTools()
  }
  loadTools()
</script>

<div class="settings-view">
  <div class="settings-header">
    <button class="back-btn" onclick={onClose}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path
          d="M10 3L5 8l5 5"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      Back to chat
    </button>
  </div>
  <div class="settings-body">
    <h2>{providerDisplayName} API key</h2>
    {#if providerRequiresApiKey}
      <p class="status">
        {hasKey ? 'A key is currently configured.' : 'No key configured yet.'} Pick a different provider
        from the model picker in the chat footer.
      </p>
      <input
        id="anthropic-key"
        type="password"
        placeholder="Paste your API key"
        bind:value={apiKey}
        onkeydown={(e) => e.key === 'Enter' && save()}
      />
      <div class="actions">
        <button onclick={onClose}>Cancel</button>
        <button class="primary" disabled={saving || !apiKey.trim()} onclick={save}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    {:else}
      <p class="status">This provider runs locally — no API key needed.</p>
      <div class="actions">
        <button onclick={onClose}>Close</button>
      </div>
    {/if}

    <hr />

    <h2>Data sources</h2>
    <p class="status">Connections the Data specialist can query (db_list_connections/db_introspect_schema/db_execute_sql).</p>

    {#if connections.length}
      <ul class="connection-list">
        {#each connections as conn (conn.id)}
          <li>
            <span class="conn-name">{conn.name}</span>
            <span class="conn-engine">{conn.engine}</span>
            <button class="link-danger" onclick={() => removeConnection(conn.id)}>Remove</button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="status">No data connections yet.</p>
    {/if}

    {#if showAddConnection}
      <div class="add-connection-form">
        <input placeholder="Connection name" bind:value={connName} />
        <select bind:value={connEngine}>
          <option value="sqlite">SQLite</option>
          <option value="postgres">Postgres</option>
        </select>
        {#if connEngine === 'sqlite'}
          <input placeholder="Path to .db file" bind:value={connFilePath} />
        {:else}
          <input placeholder="Host" bind:value={connHost} />
          <input placeholder="Port" bind:value={connPort} />
          <input placeholder="Database" bind:value={connDatabase} />
          <input placeholder="Username" bind:value={connUsername} />
          <input placeholder="Password" type="password" bind:value={connPassword} />
        {/if}
        <div class="actions">
          <button onclick={resetConnectionForm}>Cancel</button>
          <button class="primary" disabled={savingConnection || !connName.trim()} onclick={saveConnection}>
            {savingConnection ? 'Saving...' : 'Add connection'}
          </button>
        </div>
      </div>
    {:else}
      <button onclick={() => (showAddConnection = true)}>+ Add connection</button>
    {/if}

    <hr />

    <h2>Search history</h2>
    <p class="status">
      Lets the agent search your own past conversations (search_history tool). Uses a separate,
      independently-configured embedding model — not whatever provider you picked for chat above.
      Defaults to a local Ollama model, no setup required.
    </p>

    <select value={embeddingProviderId} onchange={(e) => changeEmbeddingProvider(e.currentTarget.value)}>
      {#each embeddingCapableProviders as provider (provider.id)}
        <option value={provider.id}>{provider.displayName}</option>
      {/each}
    </select>
    <input placeholder="Model (e.g. nomic-embed-text)" bind:value={embeddingModel} onblur={changeEmbeddingModel} />

    {#if embeddingCapableProviders.find((p) => p.id === embeddingProviderId)?.requiresApiKey}
      <p class="status">
        {embeddingHasKey ? 'A key is currently configured.' : 'No key configured yet.'}
      </p>
      <input
        type="password"
        placeholder="Paste your API key"
        bind:value={embeddingApiKey}
        onkeydown={(e) => e.key === 'Enter' && saveEmbeddingKey()}
      />
      <div class="actions">
        <button class="primary" disabled={savingEmbeddingKey || !embeddingApiKey.trim()} onclick={saveEmbeddingKey}>
          {savingEmbeddingKey ? 'Saving...' : 'Save key'}
        </button>
      </div>
    {:else}
      <p class="status">This provider runs locally — no API key needed.</p>
    {/if}

    <p class="status">{searchHistoryStatusLabel()}</p>
    <div class="actions">
      <button disabled={rebuildingIndex} onclick={rebuildSearchHistoryIndex}>
        {rebuildingIndex ? 'Rebuilding...' : 'Rebuild index'}
      </button>
    </div>

    <hr />

    <h2>MCP servers</h2>
    <p class="status">
      Servers whose tools get merged into the agent tool registry automatically once connected.
    </p>

    {#if mcpServers.length}
      <ul class="connection-list">
        {#each mcpServers as server (server.id)}
          <li>
            <span class="conn-name">
              {server.name}
              <span class="mcp-status" class:error={server.status === 'error'}>{mcpStatusLabel(server)}</span>
            </span>
            <span class="conn-engine">{server.transport}</span>
            <button class="link-danger" onclick={() => reconnectMcpServer(server.id)}>Reconnect</button>
            <button class="link-danger" onclick={() => removeMcpServer(server.id)}>Remove</button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="status">No MCP servers configured yet.</p>
    {/if}

    {#if showAddMcpServer}
      <div class="add-connection-form">
        <input placeholder="Server name" bind:value={mcpName} />
        <select bind:value={mcpTransport}>
          <option value="stdio">Local (stdio)</option>
          <option value="http">Remote (HTTP)</option>
        </select>
        {#if mcpTransport === 'stdio'}
          <input placeholder="Command, e.g. npx" bind:value={mcpCommand} />
          <input placeholder="Args (space-separated)" bind:value={mcpArgs} />
          <textarea placeholder={'Env vars, one per line: KEY=value'} bind:value={mcpEnv}></textarea>
        {:else}
          <input placeholder="Server URL" bind:value={mcpUrl} />
          <input placeholder="Bearer token (optional)" type="password" bind:value={mcpToken} />
        {/if}
        {#if mcpError}<p class="status error">{mcpError}</p>{/if}
        <div class="actions">
          <button onclick={resetMcpForm}>Cancel</button>
          <button class="primary" disabled={savingMcpServer || !mcpName.trim()} onclick={saveMcpServer}>
            {savingMcpServer ? 'Saving...' : 'Add server'}
          </button>
        </div>
      </div>
    {:else}
      <button onclick={() => (showAddMcpServer = true)}>+ Add MCP server</button>
    {/if}

    <hr />

    <h2>Workspace</h2>
    <p class="status">
      The folder file/shell/git/cloud-CLI tools are confined to. Changes take effect on your next
      message — no restart needed.
    </p>
    <input placeholder="Workspace folder path" bind:value={workspaceRootInput} />
    {#if workspaceError}<p class="status error">{workspaceError}</p>{/if}
    <div class="actions">
      <button
        class="primary"
        disabled={savingWorkspace || !workspaceRootInput.trim() || workspaceRootInput === workspaceRoot}
        onclick={saveWorkspaceRoot}
      >
        {savingWorkspace ? 'Saving...' : 'Save'}
      </button>
    </div>

    <hr />

    <h2>Auto-approve rules</h2>
    <p class="status">Tools checked here skip the confirmation dialog, persisted across restarts.</p>

    {#if tools.length}
      <ul class="connection-list">
        {#each tools as tool (tool.name)}
          <li>
            <label class="tool-rule">
              <input
                type="checkbox"
                checked={Boolean(autoApproveRules[tool.name])}
                onchange={(e) =>
                  onToggleAutoApproveRule(tool.name, (e.target as HTMLInputElement).checked)}
              />
              <span class="conn-name">
                {tool.name}
                {#if tool.mutates === 'sometimes'}
                  <span class="mcp-status error">
                    Only some calls of this tool mutate — enabling skips confirmation for all of them, writes included
                  </span>
                {/if}
              </span>
            </label>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="status">No tools need confirmation yet.</p>
    {/if}
  </div>
</div>

<style>
  .settings-view {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg);
  }
  .settings-header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    padding: 0.85rem 1.5rem;
    border-bottom: 1px solid var(--border);
  }
  .back-btn {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.7rem 0.4rem 0.5rem;
    border-radius: 6px;
    border: none;
    background: none;
    color: var(--text);
    font-size: 0.85rem;
    cursor: pointer;
  }
  .back-btn:hover {
    background: var(--panel-hover);
  }
  .settings-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1.5rem 2rem 3rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: 640px;
    width: 100%;
    box-sizing: border-box;
  }
  h2 {
    margin: 0 0 0.25rem;
    font-size: 1rem;
  }
  .status {
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: 0.5rem 0;
    width: 100%;
  }
  input,
  select,
  textarea {
    padding: 0.5rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-size: 0.85rem;
    font-family: inherit;
  }
  textarea {
    min-height: 3.5rem;
    resize: vertical;
  }
  .status.error {
    color: #e0654a;
  }
  .mcp-status {
    display: block;
    font-weight: 400;
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .mcp-status.error {
    color: #e0654a;
  }
  .connection-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .connection-list li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.5rem;
    border-radius: 6px;
    background: var(--bg);
    font-size: 0.85rem;
  }
  .conn-name {
    flex: 1;
    font-weight: 500;
  }
  .conn-engine {
    color: var(--text-muted);
    font-size: 0.75rem;
    text-transform: uppercase;
  }
  .tool-rule {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    flex: 1;
    cursor: pointer;
  }
  .tool-rule input {
    margin-top: 0.15rem;
  }
  .link-danger {
    background: none;
    border: none;
    color: #e0a24a;
    padding: 0;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .add-connection-form {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.6rem;
    border-radius: 8px;
    background: var(--bg);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  button {
    padding: 0.4rem 0.8rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel-hover);
    color: var(--text);
    cursor: pointer;
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #1a1a1a;
    font-weight: 600;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
