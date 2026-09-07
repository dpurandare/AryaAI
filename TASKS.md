# Sachiv — Task List

Tracks implementation work against `thouthts.md`. Every requirement below has a stable number; check items off as they land, but don't renumber — the Work Order section refers to these numbers.

## Work Order

The order we'll actually build in, referencing item numbers below. Everything still ships together — this is build sequence, not feature phasing.

1. Persistence foundation — **22**
2. Minimal key input (enough to call a provider) — **21**
3. Single-agent chat loop, end-to-end (streaming text, no tools yet) — **53**
4. Session list wired to real data + new-session flow — **26**, **23**
5. First tool + human-in-loop confirmation — **31**, **34**, **39**, **54**
6. Orchestrator (routing + agent handoff) — **27**, **28**
7. Test harness locked in against the skeleton above — **57**, **58**, **59**
8. Cross-platform CI (build/typecheck/test on mac/win/linux) — **10**
9. Widen tools — **33**, **35**, **36**, **37**, **38**, **32**
10. Widen providers — **16**, **17**, **18**, **19**, **20**
11. MCP client + config — **42**, **43**, **44**, **45**
12. Remaining config UI — **40**, **41**, **55**
13. Context management & token economy — **46**, **47**, **48**, **56**, **49**, **50**, **51**, **52**
14. Cancellation & steering — **29**, **30**
15. Session lifecycle extras — **24**, **25**
16. Ship readiness (branding, versioning, signing, auto-update, release validation) — **7**, **8**, **9**, **11**, **12**, **13**

## Scaffolding & tooling
- [x] 1. Electron + TypeScript + Svelte 5 project scaffold (electron-vite)
- [x] 2. `contextIsolation`/`sandbox` renderer hardening, typed IPC (contextBridge + invoke/handle + on/send)
- [x] 3. Embedded SQLite wired up (`better-sqlite3`), sessions table + repository
- [x] 4. OS-keychain-backed credential store (`safeStorage`)
- [x] 5. Workspace boundary path-guard utility
- [x] 6. electron-builder config (mac/win/linux targets)
- [ ] 7. App icon / branding assets (all platforms)
- [ ] 8. Decide & add tagline to app metadata

## Versioning & CI/CD
- [ ] 9. Adopt semver policy (major.minor.patch), CHANGELOG convention
- [ ] 10. CI pipeline: build + typecheck + test on macOS/Windows/Linux runners
- [ ] 11. Code signing (Windows Authenticode) + notarization (macOS) wired into CI
- [ ] 12. Auto-update feed (e.g. GitHub Releases) with signature-verified updates
- [ ] 13. Release packaging pipeline (`dist:mac`/`dist:win`/`dist:linux`) validated end-to-end

## Provider adapter layer
- [x] 14. Unified `ModelProvider` interface (messages, streaming events, tool schema)
- [x] 15. Anthropic adapter (streaming, token counting, model listing)
- [x] 16. OpenAI adapter (Chat Completions streaming + tool-call mapping; Responses API migration left for later)
- [ ] 17. Google (Gemini) adapter (Tools mapping)
- [ ] 18. Ollama adapter (local models, tool format mapping)
- [ ] 19. Provider registry: add-a-provider plugin mechanism
- [x] 20. Runtime model/provider switcher (UI + persisted preference via `app_settings` table)
- [x] 21. API key registration UI (uses keychain store)

## Persistence & sessions
- [x] 22. Message CRUD (extend `db/sessions.ts` with a `messages` repository)
- [x] 23. New-session flow (preserve current, start new)
- [ ] 24. Session export (to file, e.g. JSON/Markdown)
- [x] 25. Session delete (blocked for the currently active session — enforced in the UI, not a security boundary)
- [x] 26. Session list panel wired to real data (resizable, scrollable)

## Multi-agent system
- [ ] 27. Implement `Orchestrator.run` (routing step -> agent handoff -> result)
- [ ] 28. Define system prompts/tool sets per agent role (Planning, Research, Coding, Terminal/DevOps, Data, Distribution)
- [ ] 29. Cancellation & steering: AbortController plumbed from UI -> orchestrator -> provider stream
- [ ] 30. Mid-run steering: edit a pending tool action before it executes

## Tools
- [ ] 31. Tool registry + `Tool` interface wiring into orchestrator
- [ ] 32. Web search tool
- [ ] 33. Shell execution tool (through workspace guard)
- [ ] 34. File operations tool (through workspace guard)
- [ ] 35. Database access tool (schema introspection + generated SQL execution; writes require confirmation)
- [ ] 36. AWS tool (shells out to configured AWS CLI)
- [ ] 37. Azure tool (shells out to configured Azure CLI)
- [ ] 38. GCP tool (shells out to configured gcloud CLI)
- [ ] 39. Human-in-loop confirmation flow for all `mutates: true` tool calls
- [ ] 40. Auto-approve configuration (per tool / per workspace)
- [ ] 41. Workspace boundary configuration UI

## MCP
- [ ] 42. stdio MCP client (child process + JSON-RPC)
- [ ] 43. HTTP/SSE MCP client
- [ ] 44. MCP server configuration UI
- [ ] 45. Discovered MCP tools merged into the agent tool registry

## Context management & token economy
- [ ] 46. Exact token counting per provider (tiktoken for OpenAI, provider-native counts elsewhere)
- [ ] 47. Real-time cost estimation per session
- [ ] 48. Context-usage meter in UI (current usage vs. model limit, low-context warning)
- [ ] 49. Rolling summarization of earlier turns
- [ ] 50. Tool-output trimming after the agent extracts the essential answer
- [ ] 51. Sliding-window retention (system prompt + recent turns)
- [ ] 52. Agent-driven relevance selection (decide what enters context, not everything)

## UI
- [ ] 53. Chat view: streaming message rendering (text done; tool-use block rendering pending tools work)
- [ ] 54. Tool-call confirmation dialog (approve/deny/edit, auto-approve toggle)
- [ ] 55. Settings screens: providers/keys, MCP servers, workspace boundaries, auto-approve rules
- [ ] 56. Context/cost meter component

## Testing
- [ ] 57. Mocked-provider test harness (no live API calls in CI)
- [ ] 58. Unit tests: provider adapters, tools, workspace guard, db repositories
- [ ] 59. Integration test: full orchestrator run against a mocked provider + tool
