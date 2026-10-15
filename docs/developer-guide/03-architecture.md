# 3. Architecture

## Processes

Sachivji is an Electron app with three kinds of code:

| Part | Where | Notes |
|---|---|---|
| **Main process** | `src/main` | Node.js. Owns everything with side effects: the database, secrets, providers, tools, agents, MCP, the runtimes. |
| **Preload script** | `src/preload/index.ts` | Runs in an isolated world with a sandbox. Exposes one typed object, `window.sachiv`, through `contextBridge`. Built as CommonJS because sandboxed preloads cannot use ES modules. |
| **Renderer** | `src/renderer` | The Svelte UI. `nodeIntegration` is off, `contextIsolation` and `sandbox` are on, so it can only call what `window.sachiv` offers. |

A second renderer page, `print.html`, is a hidden window loaded only to render a chat transcript for PDF export (`sessions/export.ts` calls `webContents.printToPDF()` on it). Its Content-Security-Policy is separate from the main page's and must allow the same sources it renders (for example `img-src data:`).

`src/shared` holds the types both sides import, so the contract is checked by the compiler.

## Start-up (`src/main/index.ts`)

1. `app.setName('Sachivji')` fixes the user-data folder name.
2. On `whenReady`: set the database path (`<userData>/sachiv.db`), call `registerIpcHandlers()`, create the window (restoring saved bounds and zoom), and start the update check (packaged builds only).
3. `registerIpcHandlers()` (`ipc/register.ts`) builds the tool context and registers all handlers. It also starts, without blocking, the **workspace Python runtime**, the **bundled Ollama**, the **MCP connections**, the **saved-query tools** and the **search-history backfill**. Their progress reaches the UI through state-change events (`RuntimeStateChanged`, `OllamaStateChanged`).

## The IPC contract

Every call across the process boundary goes through three files kept in step:

1. **`src/shared/ipc-contract.ts`**: the `IpcChannel` constants (for example `sessions:list`, `chat:send`) and the DTO types for each payload.
2. **`src/preload/index.ts`**: a typed function per channel on `window.sachiv`, using `ipcRenderer.invoke` (request and response) or `ipcRenderer.on` (events pushed from main).
3. **`src/main/ipc/register.ts`**: `ipcMain.handle(IpcChannel.X, ...)` for each channel.

The renderer never touches Node or the filesystem. To add a channel, see the [extension checklists](appendix-extension-checklists.md).

### Streaming a chat turn

`chat:send` starts a turn and returns a `streamId`. From then on the main process pushes events with `webContents.send('chat:stream-event', { streamId, sessionId, event })`, where `event` is a `StreamEvent` (`src/shared/protocol.ts`): `text_delta`, `thinking_delta`, `tool_use_start`/`delta`, `tool_result`, `image`, `plan`, `plan_step_start`/`done`, `status`, `warning`, `usage`, `context_window`, `user_note`, `error` and `message_stop`. The renderer subscribes per `streamId` and unsubscribes at the final stop.

Related channels in the same stream-oriented family:

- `chat:cancel`: abort a running turn (an `AbortSignal` passed all the way down).
- `chat:steer`: queue a comment for the running turn (a mid-run steering note).
- `tools:confirm-request` / `tools:confirm-respond`: the human-in-the-loop confirmation. The orchestrator awaits a promise that the response handler resolves.
- `limit:reached-request` / `limit:reached-respond`: the "continue or stop" question when a round or time budget runs out.

## Persistence

A single SQLite file, `sachiv.db`, opened with `better-sqlite3` and extended with `sqlite-vec` (`db/index.ts`; the schema is `db/schema.sql`, applied idempotently at start-up with small in-code migrations for added columns).

| Table | Content |
|---|---|
| `sessions` | One row per chat (`id`, `title`, timestamps). |
| `messages` | One row per message: `role`, `content` (JSON `ContentBlock[]`), `created_at`, and `model` for assistant messages. |
| `app_settings` | A key/value store for every setting, including the JSON lists of connections (data, API, email, MCP). |
| `session_usage` | Token totals per session. |
| `classify_gate_log`, `tool_usage_log` | Measurement logs (planner gate calibration, real tool usage). |
| `embedding_index_meta`, `message_embeddings`, `message_chunks` plus a `sqlite-vec` virtual table | The memory index used by `search_history`. |

Foreign keys cascade from `sessions`, so deleting a chat deletes its messages, usage and embeddings.

**Secrets are not in the database.** They go through `security/keychain.ts`, which stores them with Electron's `safeStorage` (the OS keychain/DPAPI/libsecret) in a credentials file, or, if the user chose file mode at first run, in a plaintext `~/.sachivji/.env`. Connection secrets are keyed by prefix (for example `db:<id>`); the settings JSON holds everything except the secret.

**Content blocks** (`protocol.ts`) are the unit of a message: `text`, `thinking`, `tool_use`, `tool_result`, `image`, `warning` and `user_note`. A tool result that continues a turn is stored as a `user`-role message holding only `tool_result` (and `image`) blocks; code that renders or exports transcripts treats such a message as a continuation, not a new turn.

## One chat turn, end to end

`runChat` in `ipc/register.ts` is the turn runner:

1. **Resolve the provider and model** from settings (`activeProviderId`, `model:<provider>`), the API key from the secret store, and options such as prompt caching. Fail early with a clear message if any is missing.
2. **Load and prepare the conversation.** `refreshRoles()` re-reads user-defined roles; the history is read from the database and passed through `prepareConversation` (`context/prepare-context.ts`), which trims oversized tool results and drops the oldest turns to fit the model's context window, for what is *sent*, never what is stored. If turns were dropped, a warning is emitted and stored.
3. **Persist the user message** (and queue it for the memory index) and, on the first exchange, set the chat title from it.
4. **Build the orchestrator** with the provider, model, the role map (`agents`), the system prompt, the router's tool list, the confirmation callbacks, a per-turn `ToolContext` and options (planning on/off, temperature, steering queue, logging hooks).
5. **Run it** and consume its async stream (`orchestrator.run(conversation, forcedRole)`). `stream` events are forwarded to the renderer (and `usage` events are added to the session totals); `message` events are persisted as they complete and queued for the index.
6. **Clean up.** The turn's final stop is held until the run ends, because the renderer stops listening at it. Any unsaved in-progress presentation is saved automatically so composed work is never lost.

The orchestrator itself is described in [Orchestrator and agents](04-orchestrator-and-agents.md).

## Other cross-cutting pieces

- **Workspace guard** (`security/workspace-guard.ts`): real path checks that confine file tools to the workspace; outside access goes through `security/external-access.ts` (user-approved, read-only, session or permanent).
- **Runtimes** (`runtime/`): the managed Python venv and the bundled Ollama server, each with a state machine the UI observes.
- **Settings export/import** (`settings/`): copies configuration (never secrets) between machines.
- **Window helpers** (`window/`): remembered bounds, zoom shortcuts, the spell-check context menu.
- **Updater** (`updater.ts`): checks GitHub Releases on start and tells the UI about a newer version; it does not install silently.
