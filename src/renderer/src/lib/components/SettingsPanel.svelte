<script lang="ts">
  import type { RoleRosterDto, ApiAuthType, ApiConnectionDto, DataConnectionDto, EmailConnectionDto, EmailProvider, McpServerDto, McpTransport, ProviderDescriptor, SearchHistoryStatusDto, ToolDescriptor } from '@shared/ipc-contract'
  import type { ThemeMode } from '../theme'
  import type { RuntimeState } from '@shared/runtime'

  let {
    providerDisplayName,
    providerRequiresApiKey = true,
    hasKey,
    autoApproveRules,
    providers,
    themeMode,
    planningEnabled,
    onSave,
    onClose,
    onToggleAutoApproveRule,
    onChangeTheme,
    onChangePlanningEnabled
  }: {
    providerDisplayName: string
    providerRequiresApiKey?: boolean
    hasKey: boolean
    autoApproveRules: Record<string, boolean>
    providers: ProviderDescriptor[]
    themeMode: ThemeMode
    planningEnabled: boolean
    onSave: (apiKey: string) => void | Promise<void>
    onClose: () => void
    onToggleAutoApproveRule: (name: string, value: boolean) => void
    onChangeTheme: (mode: ThemeMode) => void
    onChangePlanningEnabled: (value: boolean) => void
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
  let connEngine = $state<'sqlite' | 'postgres' | 'mssql' | 'mysql'>('sqlite')
  const DEFAULT_PORT: Record<'postgres' | 'mssql' | 'mysql', string> = { postgres: '5432', mssql: '1433', mysql: '3306' }
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
      const isSqlite = connEngine === 'sqlite'
      await window.sachiv.saveDataConnection({
        name: connName.trim(),
        engine: connEngine,
        filePath: isSqlite ? connFilePath.trim() : undefined,
        host: isSqlite ? undefined : connHost.trim(),
        port: connEngine === 'sqlite' ? undefined : Number(connPort) || Number(DEFAULT_PORT[connEngine]),
        database: isSqlite ? undefined : connDatabase.trim(),
        username: isSqlite ? undefined : connUsername.trim(),
        password: !isSqlite && connPassword ? connPassword : undefined
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

  // Saved queries (curated, parametric SQL the Data agent reuses instead of
  // writing equivalent SQL fresh every time) are deliberately NOT managed
  // here — there's no Settings UI for them at all. The Data agent is the
  // only author, via its own db_save_query tool (confirmed like any other
  // mutating tool call), the runtime equivalent of the reference
  // EnergyAIProto2 app's hand-written KPI helper functions — except here
  // the "developer" with the right schema knowledge at the right time is
  // the agent, not a human at build time, since connections are arbitrary
  // and added at runtime.

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
  let mcpDescription = $state('')
  let savingMcpServer = $state(false)
  let mcpError = $state('')

  async function loadMcpServers(): Promise<void> {
    mcpServers = await window.sachiv.listMcpServers()
  }
  loadMcpServers()

  /** Max length of the one-liner — mirrors MCP_SERVER_DESCRIPTION_MAX in shared/ipc-contract.ts. */
  const MCP_DESCRIPTION_MAX = 200
  let editingMcpDescriptionId = $state<string | null>(null)
  let editingMcpDescription = $state('')

  async function saveMcpDescription(server: McpServerDto): Promise<void> {
    mcpError = ''
    try {
      // Re-sends the server's own settings unchanged; the stored bearer token is kept because none is sent.
      await window.sachiv.saveMcpServer({
        id: server.id,
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        env: server.env,
        url: server.url,
        description: editingMcpDescription.trim() || undefined
      })
      editingMcpDescriptionId = null
      await loadMcpServers()
    } catch (err) {
      mcpError = err instanceof Error ? err.message : String(err)
    }
  }

  function resetMcpForm(): void {
    mcpName = ''
    mcpTransport = 'stdio'
    mcpCommand = ''
    mcpArgs = ''
    mcpEnv = ''
    mcpUrl = ''
    mcpToken = ''
    mcpDescription = ''
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
        token: mcpTransport === 'http' && mcpToken ? mcpToken : undefined,
        description: mcpDescription.trim() || undefined
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

  // --- External APIs (api_* tools' connections) ---
  let apiConnections = $state<ApiConnectionDto[]>([])
  let showAddApiConnection = $state(false)
  let apiName = $state('')
  let apiBaseUrl = $state('')
  let apiAuthType = $state<ApiAuthType>('none')
  let apiKeyHeader = $state('X-API-Key')
  let apiUsername = $state('')
  let apiSecret = $state('')
  let apiSpecUrl = $state('')
  let savingApiConnection = $state(false)

  async function loadApiConnections(): Promise<void> {
    apiConnections = await window.sachiv.listApiConnections()
  }
  loadApiConnections()

  function resetApiConnectionForm(): void {
    apiName = ''
    apiBaseUrl = ''
    apiAuthType = 'none'
    apiKeyHeader = 'X-API-Key'
    apiUsername = ''
    apiSecret = ''
    apiSpecUrl = ''
    showAddApiConnection = false
  }

  async function saveApiConnection(): Promise<void> {
    if (!apiName.trim() || !apiBaseUrl.trim()) return
    savingApiConnection = true
    try {
      await window.sachiv.saveApiConnection({
        name: apiName.trim(),
        baseUrl: apiBaseUrl.trim(),
        authType: apiAuthType,
        apiKeyHeader: apiAuthType === 'apiKey' ? apiKeyHeader.trim() : undefined,
        username: apiAuthType === 'basic' ? apiUsername.trim() : undefined,
        secret: apiAuthType !== 'none' && apiSecret ? apiSecret : undefined,
        specUrl: apiSpecUrl.trim() || undefined
      })
      resetApiConnectionForm()
      await loadApiConnections()
    } finally {
      savingApiConnection = false
    }
  }

  async function removeApiConnection(id: string): Promise<void> {
    await window.sachiv.deleteApiConnection(id)
    await loadApiConnections()
  }

  // --- Email accounts (#79: Gmail app password, or any other SMTP server given directly — see transport.ts for why there's no Microsoft-specific option) ---
  let emailConnections = $state<EmailConnectionDto[]>([])
  let showAddEmailConnection = $state(false)
  let emailName = $state('')
  let emailProvider = $state<EmailProvider>('gmail')
  let emailAddress = $state('')
  let emailAppPassword = $state('')
  let emailHost = $state('')
  let emailPort = $state('587')
  let emailSecure = $state(false)
  let savingEmailConnection = $state(false)
  let emailConnectionError = $state('')

  const EMAIL_PROVIDER_LABELS: Record<EmailProvider, string> = {
    gmail: 'Gmail',
    custom: 'Custom SMTP'
  }

  async function loadEmailConnections(): Promise<void> {
    emailConnections = await window.sachiv.listEmailConnections()
  }
  loadEmailConnections()

  function resetEmailConnectionForm(): void {
    emailName = ''
    emailProvider = 'gmail'
    emailAddress = ''
    emailAppPassword = ''
    emailHost = ''
    emailPort = '587'
    emailSecure = false
    emailConnectionError = ''
    showAddEmailConnection = false
  }

  async function saveEmailConnectionWithValidation(): Promise<void> {
    const isCustom = emailProvider === 'custom'
    if (!emailName.trim() || !emailAddress.trim() || !emailAppPassword.trim()) return
    if (isCustom && !emailHost.trim()) return
    savingEmailConnection = true
    emailConnectionError = ''
    try {
      const host = isCustom ? emailHost.trim() : undefined
      const port = isCustom ? Number(emailPort) || 587 : undefined
      const secure = isCustom ? emailSecure : undefined
      // Real login handshake before persisting anything — same "a
      // successful probe is the validation" principle as #74, just called
      // directly by this form rather than through the tool-confirmation
      // dialog (there's no agent tool call involved in a Settings-created
      // connection).
      const result = await window.sachiv.validateEmailConnection({
        provider: emailProvider,
        emailAddress: emailAddress.trim(),
        appPassword: emailAppPassword,
        host,
        port,
        secure
      })
      if (!result.ok) {
        emailConnectionError = result.error ?? 'Could not sign in with that address/app password.'
        return
      }
      await window.sachiv.saveEmailConnection({
        name: emailName.trim(),
        provider: emailProvider,
        emailAddress: emailAddress.trim(),
        appPassword: emailAppPassword,
        host,
        port,
        secure
      })
      resetEmailConnectionForm()
      await loadEmailConnections()
    } finally {
      savingEmailConnection = false
    }
  }

  async function removeEmailConnection(id: string): Promise<void> {
    await window.sachiv.deleteEmailConnection(id)
    await loadEmailConnections()
  }

  async function makeEmailConnectionDefault(id: string): Promise<void> {
    await window.sachiv.setDefaultEmailConnection(id)
    await loadEmailConnections()
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

  // --- Python runtime (design-discussion.md 4.3, TASKS.md #110) ---
  let runtime = $state<RuntimeState | null>(null)
  let runtimeBusy = $state(false)
  let showRepairConfirm = $state(false)
  const runtimeWorking = $derived(runtime?.status === 'creating' || runtime?.packages === 'installing')

  window.sachiv.getRuntimeState().then((s) => (runtime = s))
  $effect(() => window.sachiv.onRuntimeStateChanged((s) => (runtime = s)))

  async function runtimeAction(action: () => Promise<RuntimeState>): Promise<void> {
    runtimeBusy = true
    try {
      runtime = await action()
    } finally {
      runtimeBusy = false
      showRepairConfirm = false
    }
  }

  const runtimeStatusLabel: Record<RuntimeState['status'], string> = {
    'missing-python': 'Python not found',
    creating: 'Setting up…',
    ready: 'Ready',
    failed: 'Needs attention',
    disabled: 'Turned off'
  }

  // --- Roles (design-discussion.md section 11) ---
  let roleRoster = $state<RoleRosterDto | null>(null)
  let rolesError = $state('')
  let rolesBusy = $state(false)

  async function loadRoles(): Promise<void> {
    rolesError = ''
    try {
      roleRoster = await window.sachiv.getRoles()
    } catch (err) {
      rolesError = err instanceof Error ? err.message : String(err)
    }
  }
  loadRoles()

  async function toggleRole(id: string, enabled: boolean): Promise<void> {
    rolesBusy = true
    try {
      roleRoster = await window.sachiv.setRoleEnabled(id, enabled)
    } finally {
      rolesBusy = false
    }
  }

  async function openRolesFolder(): Promise<void> {
    rolesError = ''
    try {
      await window.sachiv.openRolesFolder()
    } catch (err) {
      rolesError = err instanceof Error ? err.message : String(err)
    }
  }

  async function createExampleRole(): Promise<void> {
    rolesError = ''
    try {
      const path = await window.sachiv.createExampleRole()
      rolesError = `Example written to ${path} — rename it (remove the leading underscore) to load it, then choose Reload.`
    } catch (err) {
      rolesError = err instanceof Error ? err.message : String(err)
    }
  }

  // --- Slim router (design-discussion.md step 4; experimental, off by default) ---
  const SLIM_ROUTER_SETTING_KEY = 'slimRouter'
  let slimRouter = $state(false)
  window.sachiv.getSetting(SLIM_ROUTER_SETTING_KEY).then((v) => (slimRouter = v === 'true'))
  async function setSlimRouter(on: boolean): Promise<void> {
    slimRouter = on
    await window.sachiv.setSetting(SLIM_ROUTER_SETTING_KEY, on ? 'true' : 'false')
  }

  // --- Secret storage backend (TASKS.md #75) ---
  let secretStorageMode = $state<'keychain' | 'file'>('keychain')
  let secretStorageEnvPath = $state('')
  let switchingSecretStorage = $state(false)
  let showSwitchConfirm = $state(false)

  async function loadSecretStorageInfo(): Promise<void> {
    const info = await window.sachiv.getSecretStorageInfo()
    secretStorageMode = info.mode
    secretStorageEnvPath = info.envFilePath
  }
  loadSecretStorageInfo()

  async function confirmSwitchSecretStorageToFile(): Promise<void> {
    switchingSecretStorage = true
    try {
      const info = await window.sachiv.switchSecretStorageToFile()
      secretStorageMode = info.mode
      secretStorageEnvPath = info.envFilePath
      showSwitchConfirm = false
    } finally {
      switchingSecretStorage = false
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
  let searchHistoryStatus = $state<SearchHistoryStatusDto | null>(null)
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

  // --- Web search (Tavily — TASKS.md #32 follow-up) ---
  // Reuses the generic setApiKey/hasApiKey IPC channels exactly like every
  // provider/embedding key above — they're not restricted to registered
  // LLM providers, just a plain keychain-backed key-value store, so a
  // second, unrelated credential ("tavily") needs no new IPC surface.
  const TAVILY_KEY_ID = 'tavily'
  let tavilyHasKey = $state(false)
  let tavilyApiKey = $state('')
  let savingTavilyKey = $state(false)

  async function loadTavilyHasKey(): Promise<void> {
    tavilyHasKey = await window.sachiv.hasApiKey(TAVILY_KEY_ID)
  }
  loadTavilyHasKey()

  async function saveTavilyKey(): Promise<void> {
    if (!tavilyApiKey.trim()) return
    savingTavilyKey = true
    try {
      await window.sachiv.setApiKey(TAVILY_KEY_ID, tavilyApiKey.trim())
      tavilyApiKey = ''
      await loadTavilyHasKey()
    } finally {
      savingTavilyKey = false
    }
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
    if (searchHistoryStatus.state === 'unavailable') {
      // Every embed attempt so far has failed and nothing has ever been
      // indexed — most commonly Ollama not running or the embedding model
      // not pulled yet (see README's Prerequisites). Distinct from
      // 'empty', which just means nothing's been sent yet.
      return `Search history disabled — ${searchHistoryStatus.reason}`
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
    <h2>Appearance</h2>
    <p class="status">Choose a light or dark look, or follow your system setting.</p>
    <div class="theme-toggle" role="radiogroup" aria-label="Theme">
      {#each [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']] as [mode, label] (mode)}
        <button
          type="button"
          role="radio"
          aria-checked={themeMode === mode}
          class:active={themeMode === mode}
          onclick={() => onChangeTheme(mode as ThemeMode)}
        >
          {label}
        </button>
      {/each}
    </div>

    <hr />

    <h2>Orchestrator</h2>
    <p class="status">
      Plan complex requests before acting — classifies each message and, for a genuinely multi-part
      request, builds an ordered step list before running it, instead of deciding step-by-step as it
      goes. Adds one extra round-trip per message; turn off if your local model's per-round latency makes
      that too slow.
    </p>
    <label class="tool-rule">
      <input
        type="checkbox"
        checked={planningEnabled}
        onchange={(e) => onChangePlanningEnabled((e.target as HTMLInputElement).checked)}
      />
      <span class="conn-name">Plan complex requests before acting</span>
    </label>

    <hr />

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
        <select
          value={connEngine}
          onchange={(e) => {
            connEngine = e.currentTarget.value as typeof connEngine
            if (connEngine !== 'sqlite') connPort = DEFAULT_PORT[connEngine]
          }}
        >
          <option value="sqlite">SQLite</option>
          <option value="postgres">Postgres</option>
          <option value="mssql">SQL Server</option>
          <option value="mysql">MySQL</option>
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

    <h2>Web search</h2>
    <p class="status">
      web_search uses Tavily (a real search API built for AI agents) when a key is set here — real
      ranked results with real URLs, not just DuckDuckGo's narrow Instant Answer API. Falls back to
      DuckDuckGo automatically when no key is configured.
    </p>
    <p class="status">
      {tavilyHasKey ? 'A Tavily key is currently configured.' : 'No Tavily key configured — falling back to DuckDuckGo.'}
    </p>
    <input
      type="password"
      placeholder="Paste your Tavily API key"
      bind:value={tavilyApiKey}
      onkeydown={(e) => e.key === 'Enter' && saveTavilyKey()}
    />
    <div class="actions">
      <button class="primary" disabled={savingTavilyKey || !tavilyApiKey.trim()} onclick={saveTavilyKey}>
        {savingTavilyKey ? 'Saving...' : 'Save key'}
      </button>
    </div>

    <hr />

    <h2>MCP servers</h2>
    <p class="status">
      Servers whose tools become available through the MCP Operator specialist once connected. Write a short line about what each
      one is for — that line (not the server's own text) is what the assistant uses to pick the right server.
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
          <li class="mcp-description-row">
            {#if editingMcpDescriptionId === server.id}
              <input
                placeholder="What is this server for? (max {MCP_DESCRIPTION_MAX} characters)"
                maxlength={MCP_DESCRIPTION_MAX}
                bind:value={editingMcpDescription}
              />
              <button class="primary" onclick={() => saveMcpDescription(server)}>Save</button>
              <button onclick={() => (editingMcpDescriptionId = null)}>Cancel</button>
            {:else}
              <span class="status">{server.description || 'No description — the assistant only sees tool names.'}</span>
              <button
                class="link-danger"
                onclick={() => {
                  editingMcpDescriptionId = server.id
                  editingMcpDescription = server.description ?? ''
                }}>Edit description</button
              >
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="status">No MCP servers configured yet.</p>
    {/if}

    {#if showAddMcpServer}
      <div class="add-connection-form">
        <input placeholder="Server name" bind:value={mcpName} />
        <input placeholder="What is this server for? (optional, max {MCP_DESCRIPTION_MAX} characters)" maxlength={MCP_DESCRIPTION_MAX} bind:value={mcpDescription} />
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

    <h2>External APIs</h2>
    <p class="status">
      Third-party REST APIs the agent can introspect and call (api_list_connections/api_introspect/
      api_call/api_check_status). GET/HEAD/OPTIONS run immediately; anything else needs confirmation
      first, same as every other mutating tool.
    </p>

    {#if apiConnections.length}
      <ul class="connection-list">
        {#each apiConnections as conn (conn.id)}
          <li>
            <span class="conn-name">{conn.name}</span>
            <span class="conn-engine">{conn.authType}</span>
            <button class="link-danger" onclick={() => removeApiConnection(conn.id)}>Remove</button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="status">No API connections yet.</p>
    {/if}

    {#if showAddApiConnection}
      <div class="add-connection-form">
        <input placeholder="Connection name" bind:value={apiName} />
        <input placeholder="Base URL, e.g. https://api.example.com/v1" bind:value={apiBaseUrl} />
        <select bind:value={apiAuthType}>
          <option value="none">No auth</option>
          <option value="apiKey">API key header</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic auth</option>
        </select>
        {#if apiAuthType === 'apiKey'}
          <input placeholder="Header name, e.g. X-API-Key" bind:value={apiKeyHeader} />
          <input placeholder="API key" type="password" bind:value={apiSecret} />
        {:else if apiAuthType === 'bearer'}
          <input placeholder="Bearer token" type="password" bind:value={apiSecret} />
        {:else if apiAuthType === 'basic'}
          <input placeholder="Username" bind:value={apiUsername} />
          <input placeholder="Password" type="password" bind:value={apiSecret} />
        {/if}
        <input placeholder="OpenAPI/Swagger spec URL (optional)" bind:value={apiSpecUrl} />
        <div class="actions">
          <button onclick={resetApiConnectionForm}>Cancel</button>
          <button
            class="primary"
            disabled={savingApiConnection || !apiName.trim() || !apiBaseUrl.trim()}
            onclick={saveApiConnection}
          >
            {savingApiConnection ? 'Saving...' : 'Add connection'}
          </button>
        </div>
      </div>
    {:else}
      <button onclick={() => (showAddApiConnection = true)}>+ Add API connection</button>
    {/if}

    <hr />

    <h2>Email accounts</h2>
    <p class="status">
      Accounts the Email specialist can send from — Gmail via an app password, or any other SMTP
      server (host/port given directly) with its own credentials. <a
        href="https://support.google.com/accounts/answer/185833"
        target="_blank"
        rel="noopener noreferrer">Gmail app password</a
      >. <strong>No Microsoft (Office 365/Outlook/Hotmail) option</strong> — tried one and reverted:
      confirmed live that Microsoft has fully retired SMTP app-password sign-in for both work and
      personal Microsoft accounts, with no per-account way to turn it back on. A real Outlook option
      needs a different integration (Microsoft sign-in, not a password field) that isn't built yet.
    </p>
    {#if emailConnections.length}
      <ul class="connection-list">
        {#each emailConnections as conn (conn.id)}
          <li>
            <span class="conn-name">{conn.name}{#if conn.isDefault}<span class="default-badge">default</span>{/if}</span>
            <span class="conn-engine">{conn.emailAddress} ({EMAIL_PROVIDER_LABELS[conn.provider]})</span>
            {#if !conn.isDefault}
              <button class="link" onclick={() => makeEmailConnectionDefault(conn.id)}>Set as default</button>
            {/if}
            <button class="link-danger" onclick={() => removeEmailConnection(conn.id)}>Remove</button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="status">No email accounts yet.</p>
    {/if}

    {#if showAddEmailConnection}
      <div class="add-connection-form">
        <input placeholder="Display name, e.g. Work Gmail" bind:value={emailName} />
        <select value={emailProvider} onchange={(e) => (emailProvider = e.currentTarget.value as EmailProvider)}>
          <option value="gmail">Gmail</option>
          <option value="custom">Custom SMTP server</option>
        </select>
        <input placeholder="Email address" bind:value={emailAddress} />
        <input placeholder="Password / app password" type="password" bind:value={emailAppPassword} />
        {#if emailProvider === 'custom'}
          <input placeholder="SMTP host, e.g. smtp.example.com" bind:value={emailHost} />
          <input placeholder="Port (587 = STARTTLS, 465 = TLS)" bind:value={emailPort} />
          <label class="checkbox-row">
            <input type="checkbox" bind:checked={emailSecure} />
            Use TLS on connect (typically port 465 — leave unchecked for STARTTLS on 587)
          </label>
        {/if}
        {#if emailConnectionError}<p class="status error">{emailConnectionError}</p>{/if}
        <div class="actions">
          <button onclick={resetEmailConnectionForm}>Cancel</button>
          <button
            class="primary"
            disabled={savingEmailConnection ||
              !emailName.trim() ||
              !emailAddress.trim() ||
              !emailAppPassword.trim() ||
              (emailProvider === 'custom' && !emailHost.trim())}
            onclick={saveEmailConnectionWithValidation}
          >
            {savingEmailConnection ? 'Signing in...' : 'Add account'}
          </button>
        </div>
      </div>
    {:else}
      <button onclick={() => (showAddEmailConnection = true)}>+ Add email account</button>
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

    <h2>Python runtime</h2>
    <p class="status">
      Agents run scripts (charts, Word/Excel files) in a Python environment stored in the
      workspace's <code>venv</code> folder. It is created automatically when Python 3.10 or newer is
      installed. It keeps packages separate but is <strong>not a sandbox</strong> — scripts can still
      read and write anywhere you can.
    </p>
    {#if runtime}
      <p class="status" class:error={runtime.status === 'failed' || runtime.status === 'missing-python'}>
        <strong>{runtimeStatusLabel[runtime.status]}</strong>{runtime.pythonVersion ? ` · Python ${runtime.pythonVersion}` : ''}
        — {runtime.message}
      </p>
      {#if runtime.packages === 'adopted'}
        <p class="status">Packages in an existing environment are yours to manage; Sachivji did not install any.</p>
      {/if}
      {#if !showRepairConfirm}
        <div class="actions">
          {#if runtime.status === 'disabled'}
            <button class="primary" disabled={runtimeBusy} onclick={() => runtimeAction(() => window.sachiv.setRuntimeEnabled(true))}>
              Turn Python on
            </button>
          {:else}
            <button disabled={runtimeBusy || runtimeWorking} onclick={() => runtimeAction(() => window.sachiv.ensureRuntime())}>
              Retry
            </button>
            <button disabled={runtimeBusy || runtimeWorking} onclick={() => (showRepairConfirm = true)}>Repair…</button>
            <button disabled={runtimeBusy || runtimeWorking} onclick={() => runtimeAction(() => window.sachiv.setRuntimeEnabled(false))}>
              Turn Python off
            </button>
          {/if}
        </div>
      {:else}
        <p class="status">
          Repair deletes the workspace's <code>venv</code> folder — including any packages you
          installed into it — and builds a fresh one. Your own files are not touched. Continue?
        </p>
        <div class="actions">
          <button onclick={() => (showRepairConfirm = false)}>Cancel</button>
          <button class="primary" disabled={runtimeBusy} onclick={() => runtimeAction(() => window.sachiv.repairRuntime())}>
            Delete and rebuild
          </button>
        </div>
      {/if}
    {:else}
      <p class="status">Checking…</p>
    {/if}

    <hr />

    <h2>Roles</h2>
    <p class="status">
      The specialists the assistant can hand work to. Add your own by putting a Markdown file (frontmatter + the role's prompt) in the roles
      folder; it loads enabled and applies to your next message. A role only chooses among existing tools — confirmation and the workspace
      boundary still apply to everything it does. Every enabled role's summary is sent with every request, so keep the list short.
    </p>
    {#if roleRoster}
      <p class="status"><code>{roleRoster.folder}</code></p>
      <div class="actions">
        <button onclick={openRolesFolder}>Open roles folder</button>
        <button onclick={createExampleRole}>Create example file</button>
        <button onclick={loadRoles}>Reload</button>
      </div>
      {#if rolesError}<p class="status">{rolesError}</p>{/if}
      {#if roleRoster.budgetWarning}<p class="status error">{roleRoster.budgetWarning}</p>{/if}

      {@const yours = roleRoster.roles.filter((r) => !r.builtin)}
      {#if yours.length}
        <ul class="connection-list">
          {#each yours as r (r.id)}
            <li class="role-row">
              <div class="role-head">
                <label class="checkbox-row">
                  <input type="checkbox" checked={r.enabled} disabled={rolesBusy} onchange={(e) => toggleRole(r.id, e.currentTarget.checked)} />
                  <span class="conn-name">{r.label} <span class="mcp-status">{r.id}</span></span>
                </label>
                <span class="conn-engine">~{r.tokenCost} tokens per request</span>
              </div>
              <span class="status">{r.summary}</span>
              {#if r.stale}<span class="status error">The latest edit of {r.file} has errors — using the last working version.</span>{/if}
              {#each r.warnings as w}<span class="status">⚠ {w}</span>{/each}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="status">No roles of your own yet.</p>
      {/if}

      {#each roleRoster.problems.filter((p) => p.level === 'error') as p}
        <p class="status error"><strong>{p.file}</strong> — {p.message}</p>
      {/each}
      {#each roleRoster.problems.filter((p) => p.level === 'warning') as p}
        <p class="status"><strong>{p.file}</strong> — {p.message}</p>
      {/each}

      <details>
        <summary class="status">Built-in roles ({roleRoster.roles.filter((r) => r.builtin).length}, read-only)</summary>
        <ul class="connection-list">
          {#each roleRoster.roles.filter((r) => r.builtin) as r (r.id)}
            <li class="role-row">
              <div class="role-head">
                <span class="conn-name">{r.label} <span class="mcp-status">{r.id}</span></span>
                <span class="conn-engine">~{r.tokenCost} tokens per request</span>
              </div>
              <span class="status">{r.summary}</span>
            </li>
          {/each}
        </ul>
      </details>
    {:else}
      <p class="status">Loading…</p>
    {/if}

    <hr />

    <h2>Slim router <span class="status">(experimental)</span></h2>
    <p class="status">
      Sends the assistant a much smaller request each time (about 2,800 tokens instead of about 10,800) by keeping only a few
      everyday tools directly and reaching everything else through the specialists. Applies to your next message. Routing quality
      has not yet been evaluated across models, so leave this off unless you are testing it.
    </p>
    <label class="checkbox-row">
      <input type="checkbox" checked={slimRouter} onchange={(e) => setSlimRouter(e.currentTarget.checked)} />
      Use the slim router
    </label>

    <hr />

    <h2>Secret storage</h2>
    <p class="status">
      Where provider API keys and DB/API/MCP connection secrets are kept.
    </p>
    {#if secretStorageMode === 'keychain'}
      <p class="status">Secret storage: <strong>OS Keychain</strong> (encrypted, OS-native).</p>
      {#if !showSwitchConfirm}
        <button onclick={() => (showSwitchConfirm = true)}>Switch to file storage instead</button>
      {:else}
        <p class="status">
          This moves every secret into a plaintext file at <code>{secretStorageEnvPath}</code> —
          less secure than the OS keychain, and there's no way to switch back once done. The
          keychain keeps a live backup afterward, so nothing is deleted. Are you sure?
        </p>
        <div class="actions">
          <button onclick={() => (showSwitchConfirm = false)}>Cancel</button>
          <button class="primary" disabled={switchingSecretStorage} onclick={confirmSwitchSecretStorageToFile}>
            {switchingSecretStorage ? 'Switching...' : 'Switch to file storage'}
          </button>
        </div>
      {/if}
    {:else}
      <p class="status">
        Secret storage: <strong>File</strong> (<code>{secretStorageEnvPath}</code>).
      </p>
    {/if}

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
    color: var(--danger);
  }
  .theme-toggle {
    display: flex;
    gap: 0.4rem;
  }
  .theme-toggle button {
    flex: 1;
    background: var(--bg);
  }
  .theme-toggle button.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #1a1a1a;
    font-weight: 600;
  }
  .mcp-status {
    display: block;
    font-weight: 400;
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .mcp-status.error {
    color: var(--danger);
  }
  .connection-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .connection-list li.role-row {
    flex-direction: column;
    align-items: stretch;
    gap: 0.25rem;
  }
  .role-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
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
    color: var(--warn);
    padding: 0;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .link {
    background: none;
    border: none;
    color: var(--accent);
    padding: 0;
    font-size: 0.75rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .default-badge {
    margin-left: 0.5rem;
    padding: 0.05rem 0.4rem;
    border-radius: 4px;
    background: var(--accent);
    color: var(--bg);
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .add-connection-form {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.6rem;
    border-radius: 8px;
    background: var(--bg);
  }
  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: var(--text-muted);
    cursor: pointer;
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
