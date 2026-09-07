# Sachiv — Task List

Tracks implementation work against `thouthts.md`. Check items off as they land.

## Scaffolding & tooling
- [x] Electron + TypeScript + Svelte 5 project scaffold (electron-vite)
- [x] `contextIsolation`/`sandbox` renderer hardening, typed IPC (contextBridge + invoke/handle + on/send)
- [x] Embedded SQLite wired up (`better-sqlite3`), sessions table + repository
- [x] OS-keychain-backed credential store (`safeStorage`)
- [x] Workspace boundary path-guard utility
- [x] electron-builder config (mac/win/linux targets)
- [ ] App icon / branding assets (all platforms)
- [ ] Decide & add tagline to app metadata

## Versioning & CI/CD
- [ ] Adopt semver policy (major.minor.patch), CHANGELOG convention
- [ ] CI pipeline: build + typecheck + test on macOS/Windows/Linux runners
- [ ] Code signing (Windows Authenticode) + notarization (macOS) wired into CI
- [ ] Auto-update feed (e.g. GitHub Releases) with signature-verified updates
- [ ] Release packaging pipeline (`dist:mac`/`dist:win`/`dist:linux`) validated end-to-end

## Provider adapter layer
- [x] Unified `ModelProvider` interface (messages, streaming events, tool schema)
- [x] Anthropic adapter (streaming, token counting, model listing)
- [ ] OpenAI adapter (Chat Completions/Responses API, function calling mapping)
- [ ] Google (Gemini) adapter (Tools mapping)
- [ ] Ollama adapter (local models, tool format mapping)
- [ ] Provider registry: add-a-provider plugin mechanism
- [ ] Runtime model/provider switcher (UI + persisted preference)
- [ ] API key registration UI (uses keychain store)

## Persistence & sessions
- [ ] Message CRUD (extend `db/sessions.ts` with a `messages` repository)
- [ ] New-session flow (preserve current, start new)
- [ ] Session export (to file, e.g. JSON/Markdown)
- [ ] Session delete (blocked for the currently active session)
- [ ] Session list panel wired to real data (resizable, scrollable)

## Multi-agent system
- [ ] Implement `Orchestrator.run` (routing step -> agent handoff -> result)
- [ ] Define system prompts/tool sets per agent role (Planning, Research, Coding, Terminal/DevOps, Data, Distribution)
- [ ] Cancellation & steering: AbortController plumbed from UI -> orchestrator -> provider stream
- [ ] Mid-run steering: edit a pending tool action before it executes

## Tools
- [ ] Tool registry + `Tool` interface wiring into orchestrator
- [ ] Web search tool
- [ ] Shell execution tool (through workspace guard)
- [ ] File operations tool (through workspace guard)
- [ ] Database access tool (schema introspection + generated SQL execution; writes require confirmation)
- [ ] AWS tool (shells out to configured AWS CLI)
- [ ] Azure tool (shells out to configured Azure CLI)
- [ ] GCP tool (shells out to configured gcloud CLI)
- [ ] Human-in-loop confirmation flow for all `mutates: true` tool calls
- [ ] Auto-approve configuration (per tool / per workspace)
- [ ] Workspace boundary configuration UI

## MCP
- [ ] stdio MCP client (child process + JSON-RPC)
- [ ] HTTP/SSE MCP client
- [ ] MCP server configuration UI
- [ ] Discovered MCP tools merged into the agent tool registry

## Context management & token economy
- [ ] Exact token counting per provider (tiktoken for OpenAI, provider-native counts elsewhere)
- [ ] Real-time cost estimation per session
- [ ] Context-usage meter in UI (current usage vs. model limit, low-context warning)
- [ ] Rolling summarization of earlier turns
- [ ] Tool-output trimming after the agent extracts the essential answer
- [ ] Sliding-window retention (system prompt + recent turns)
- [ ] Agent-driven relevance selection (decide what enters context, not everything)

## UI
- [ ] Chat view: streaming message rendering (text + tool-use blocks)
- [ ] Tool-call confirmation dialog (approve/deny/edit, auto-approve toggle)
- [ ] Settings screens: providers/keys, MCP servers, workspace boundaries, auto-approve rules
- [ ] Context/cost meter component

## Testing
- [ ] Mocked-provider test harness (no live API calls in CI)
- [ ] Unit tests: provider adapters, tools, workspace guard, db repositories
- [ ] Integration test: full orchestrator run against a mocked provider + tool
