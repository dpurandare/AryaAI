# Sachivji — Task List

Tracks implementation work against `thouthts.md`. Every requirement below has a stable number; check items off as they land, but don't renumber — the Work Order section refers to these numbers.

## Work Order

The order we'll actually build in, referencing item numbers below. Everything still ships together — this is build sequence, not feature phasing.

1. Persistence foundation — **22**
2. Minimal key input (enough to call a provider) — **21**
3. Single-agent chat loop, end-to-end (streaming text, no tools yet) — **53**
4. Session list wired to real data + new-session flow — **26**, **23**
5. First tool + human-in-loop confirmation — **31**, **34**, **39**, **54**
6. Cross-platform CI (build/typecheck/test on mac/win/linux) — **10**
7. Orchestrator (routing + agent handoff) — **27**, **28**
8. Test harness locked in against the skeleton above — **57**, **58**, **59**
9. Widen tools — **33**, **35**, **36**, **37**, **38**, **32**
10. Widen providers — **16**, **17**, **18**, **19**, **20**
11. Widen tools further: git & GitHub CLI — **60**, **61**
12. MCP client + config — **42**, **43**, **44**, **45**
13. Remaining config UI — **40**, **41**, **55**
14. Context management & token economy — **46**, **47**, **48**, **56**, **49**, **50**, **51**, **52**
15. Cancellation & steering — **29**, **30**
16. Session lifecycle extras — **24**, **25**
17. Ship readiness (branding, versioning, signing, auto-update, release validation) — **7**, **8**, **9**, **11**, **12**, **13**
18. Generic API access tool (introspection, authenticated calls, pagination, async job-status polling) — **70**

## Scaffolding & tooling
- [x] 1. Electron + TypeScript + Svelte 5 project scaffold (electron-vite)
- [x] 2. `contextIsolation`/`sandbox` renderer hardening, typed IPC (contextBridge + invoke/handle + on/send)
- [x] 3. Embedded SQLite wired up (`better-sqlite3`), sessions table + repository
- [x] 4. OS-keychain-backed credential store (`safeStorage`)
- [x] 5. Workspace boundary path-guard utility
- [x] 6. electron-builder config (mac/win/linux targets)
- [x] 7. App icon / branding assets (all platforms) — placeholder monogram (`build/icon-source.svg`), generated to `.icns`/`.ico`/`.png` via `npm run icons:generate` (icon-gen + sharp); swap the source SVG and regenerate for real brand art later
- [x] 8. Decide & add tagline to app metadata — "Sachivji — your local-first, multi-agent AI companion." in `package.json`'s `description` (feeds Windows/Linux installer metadata) and `README.md` (renamed from "Sachiv" to "Sachivji" — more respectful-sounding, per explicit request)

## Versioning & CI/CD
- [x] 9. Adopt semver policy (major.minor.patch), CHANGELOG convention — policy documented in `README.md`'s Versioning section, `CHANGELOG.md` added (Keep a Changelog format)
- [x] 10. CI pipeline: build + typecheck + test on macOS/Windows/Linux runners
- [ ] 11. Code signing (Windows Authenticode) + notarization (macOS) wired into CI — blocked on 63-65 (external credentials the user needs to obtain)
- [ ] 63. Apple Developer Program enrollment ($99/yr) + generate a "Developer ID Application" certificate — user action, needed before macOS signing/notarization can be wired up
- [ ] 64. Apple notarization credentials (an app-specific password or App Store Connect API key) generated and added as CI secrets — depends on 63
- [ ] 65. Windows code-signing (Authenticode) certificate obtained (e.g. DigiCert/SSL.com/Sectigo — OV is cheaper than EV, EV avoids SmartScreen reputation warm-up) — user action
- [ ] 66. Wire real signing + notarization into `electron-builder.yml` and `release.yml` once 63-65 exist — sets `mac.identity`/notarize config and `win.certificateFile`/`certificatePassword` (or CI secret equivalents), replacing the interim `mac.identity: null` / unsigned-Windows defaults
- [x] 12. Auto-update feed (e.g. GitHub Releases) with signature-verified updates — check-only, not silent auto-apply: `electron-updater` checks the GitHub Releases feed and notifies the user with a link; `autoDownload` stays off since an unsigned build (see #11) can't reliably self-replace, especially on macOS
- [x] 13. Release packaging pipeline (`dist:mac`/`dist:win`/`dist:linux`) validated end-to-end — real `release.yml` run against the `v0.1.0` tag, all 3 platforms green, draft GitHub Release has all 9 expected assets (dmg+blockmap+latest-mac.yml, exe+blockmap+latest.yml, AppImage+deb+latest-linux.yml). Found and fixed two real bugs along the way: electron-builder needs `author.email` in `package.json` for `.deb` packaging (fixed with a GitHub no-reply address, not a real personal email, since it's public package metadata) and, even with that, the CI environment specifically still failed the same check for a reason never fully root-caused (a real Linux container reproduction on this machine built fine with the same fix) — resolved more robustly by setting `deb.maintainer` directly in `electron-builder.yml`, bypassing that code path entirely. Draft release is unpublished — user reviews and publishes manually.

  **Follow-up, discovered while adding `sqlite-vec` (#52)**: "validated end-to-end" above meant the CI *build* succeeding on all 3 platforms — it never actually *launched* a packaged app, which turned out to hide a real, launch-blocking bug. First-ever launch of a packaged build (`electron-builder --mac --dir`, run manually on this machine) hung behind a native "uncaught exception" dialog: native binaries (`.node` addons, `sqlite-vec`'s platform `.dylib`) can't `dlopen()` from inside the asar archive, and neither `require.resolve()` nor `import.meta.resolve()` redirect to `app.asar.unpacked` for that case (Electron's asar-unpack redirect is special-cased to its own native-addon `require()`, not to a resolved path a caller then hands to something else). Fixed with `asarUnpack` in `electron-builder.yml` (necessary but not sufficient alone) plus an explicit path rewrite in `src/main/db/index.ts` before calling `loadExtension()`. Verified live on macOS only (no Windows/Linux binaries runnable on this machine) — the fix is platform-symmetric in principle, not empirically confirmed on those two. **Real gap, not fixed here**: neither CI nor this process actually launches a packaged build automatically — this bug would have shipped in the real `v0.1.0` release silently. Worth a future CI step that launches the packaged app and checks for a clean start, not just a successful build.

## Provider adapter layer
- [x] 14. Unified `ModelProvider` interface (messages, streaming events, tool schema)
- [x] 15. Anthropic adapter (streaming, token counting, model listing)
- [x] 16. OpenAI adapter (Chat Completions streaming + tool-call mapping; Responses API migration left for later)
- [x] 17. Google (Gemini) adapter (Tools mapping)
- [x] 18. Ollama adapter (local models, tool format mapping)
- [x] 19. Provider registry: add-a-provider plugin mechanism
- [x] 20. Runtime model/provider switcher (UI + persisted preference via `app_settings` table)
- [x] 21. API key registration UI (uses keychain store)

## Persistence & sessions
- [x] 22. Message CRUD (extend `db/sessions.ts` with a `messages` repository)
- [x] 23. New-session flow (preserve current, start new)
- [x] 24. Session export (to file, e.g. JSON/Markdown) — native save dialog, format inferred from the chosen extension
- [x] 25. Session delete (blocked for the currently active session — enforced in the UI, not a security boundary)
- [x] 26. Session list panel wired to real data (resizable, scrollable)
- [x] 69. Auto-title a session from its first message — replaces the generic "New Chat" placeholder exactly once (`db/sessions.ts`'s `titleFromMessage`), pushed live to the renderer via `SessionTitleUpdated` so an already-open session list updates without a reload.

## Multi-agent system
- [x] 27. Implement `Orchestrator.run` (routing step -> agent handoff -> result; tool-call loop below moves here once it lands)
- [x] 28. Define system prompts/tool sets per agent role (Planning, Research, Coding, Terminal/DevOps, Data, Distribution)
- [x] 29. Cancellation & steering: AbortController plumbed from UI -> orchestrator -> provider stream — cancels the in-flight streaming response; does not interrupt a tool already executing or auto-dismiss an open confirmation dialog (the existing Deny button covers that)
- [x] 30. Mid-run steering: edit a pending tool action before it executes — was already implemented via the confirmation dialog's editable JSON, just never checked off; live-verified this pass (edited a write_file call's content, confirmed the edit — not the model's original — landed on disk)

## Tools
- [x] 31. Tool registry + `Tool` interface wired into the chat loop (moves to the orchestrator when #27 lands)
- [x] 32. Web search tool
- [x] 33. Shell execution tool (through workspace guard)
- [x] 34. File operations tool (through workspace guard): `read_file`, `list_directory`, `write_file`
- [x] 35. Database access tool (schema introspection + generated SQL execution; writes require confirmation) — since extended with mechanical CRUD tools (`db_list_rows`/`db_count_rows`/`db_find_rows`, no SQL needed for a simple per-table lookup), agent-authored parametric saved queries (`db_save_query` — the Data agent itself writes and confirms a reusable named query once a question is likely to recur, exposed afterward as its own directly-callable `db_query_<slug>_<id>` tool; no human-facing Settings UI for these on purpose, since a connection's schema isn't known until the agent has actually introspected it), and a cached per-connection table-name hint (`schemaSummary`, refreshed opportunistically on `db_introspect_schema`) so `db_list_connections` can help pick the right connection among several with zero extra tool calls.
- [x] 36. AWS tool (shells out to configured AWS CLI)
- [x] 37. Azure tool (shells out to configured Azure CLI)
- [x] 38. GCP tool (shells out to configured gcloud CLI)
- [x] 39. Human-in-loop confirmation flow for all `mutates: true` tool calls
- [x] 40. Auto-approve configuration (per tool) — persisted, restart-surviving rules, settable from the confirmation dialog or a Settings list; the #54 session-only blanket toggle stays as an additive quick option. No per-workspace axis — only one workspace root exists at a time, so that dimension is moot until multi-workspace support lands.
- [x] 41. Workspace boundary configuration UI
- [x] 60. Git operations tool (status/diff/log/branch/commit/etc., through workspace guard; mutating operations require confirmation)
- [x] 61. GitHub CLI tool (shells out to a configured `gh` — issues, PRs, repo operations, same pattern as the AWS/Azure/GCP CLI tools)
- [x] 70. Generic API access tool (Research role) — connections configured in Settings > External APIs (name, base URL, auth: none/API key header/bearer/basic, optional OpenAPI/Swagger spec URL), same keychain-backed secret storage as data connections/MCP tokens. `api_list_connections` (cheap routing hint), `api_introspect` (fetches and parses an OpenAPI/Swagger spec — the configured specUrl, or a probe of common well-known paths — into a condensed endpoint/parameter list, caching a summary), `api_call` (method/path/query/headers/body, `mutates` computed per call from the HTTP method — GET/HEAD/OPTIONS run immediately, anything else needs confirmation; `paginate:true` follows a Link `rel="next"` header or a common "next"-style JSON field across pages up to a capped `maxPages`), `api_check_status` (bounded polling of an async job — a 202 response or a pending-status-plus-id body — within one call; still-pending returns the same statusUrl to retry on a later turn rather than blocking indefinitely). Live-verified against a real public API (JSONPlaceholder): the Research agent called `api_call` for real and correctly reported real response data; pagination/async-job detection/introspection are covered by mocked unit tests only, not a second live network round-trip.

## MCP
- [x] 42. stdio MCP client (child process + JSON-RPC)
- [x] 43. HTTP/SSE MCP client
- [x] 44. MCP server configuration UI
- [x] 45. Discovered MCP tools merged into the agent tool registry

## Context management & token economy
- [x] 46. Exact token counting per provider (tiktoken for OpenAI, provider-native counts elsewhere) — tiktoken (js-tiktoken, o200k_base) for OpenAI and, as a documented approximation-of-an-approximation, Ollama; real API-based counts already existed for Anthropic/Google
- [x] 47. Real-time cost estimation per session — approximate, hand-maintained pricing table (`src/shared/model-metadata.ts`); unknown models show "cost unknown" rather than a fabricated number, Ollama models are correctly free
- [x] 48. Context-usage meter in UI (current usage vs. model limit, low-context warning) — tracks cumulative session usage (not live post-trim context size, which #51 now keeps bounded by design) against the model's context window, with a warning state past ~80%
- [ ] 49. Rolling summarization of earlier turns — deferred, needs its own LLM-call/trigger-policy design
- [x] 50. Tool-output trimming after the agent extracts the essential answer — oversized tool_result content capped (~4000 chars) only in what's sent to the provider; full result always stays in SQLite and the UI transcript
- [x] 51. Sliding-window retention (system prompt + recent turns) — drops the oldest complete turns once `provider.countTokens()` exceeds ~70% of the model's context window, never splitting a tool_use/tool_result pair
- [x] 52. Agent-driven relevance selection (decide what enters context, not everything) — a `search_history` tool (Research role), not a silent automatic mechanism: searches the user's own past conversations across all sessions via vector search (`sqlite-vec`), returns tagged excerpts with session/date. Embedding storage/generation is a separate, independently-configured (provider, model) pair from the chat provider — defaults to Ollama (`nomic-embed-text`), reconfigurable to OpenAI/Google (Anthropic has no embeddings API). Degrades cleanly with a clear message when no working embedding model is available, rather than failing silently.

## UI
- [x] 53. Chat view: streaming message rendering (text + tool-use/tool-result block rendering)
- [x] 54. Tool-call confirmation dialog (approve/deny/edit, session auto-approve toggle)
- [x] 55. Settings screens: providers/keys, MCP servers, workspace boundaries, auto-approve rules
- [x] 56. Context/cost meter component — `ContextMeter.svelte`, in `ChatView`'s status bar
- [ ] 62. Mermaid diagram rendering in chat Markdown — detect ```mermaid fenced code blocks in `MarkdownText.svelte` and render them via the `mermaid` npm package (SVG output) instead of leaving them as plain code text; needs async render handling (`mermaid.render()` returns a Promise) and a DOMPurify SVG-safe config (`USE_PROFILES: { svg: true }` or equivalent), since sanitizing SVG output differs from the HTML allowlist used for regular Markdown — deferred, not part of the current Work Order
- [x] 67. Display mode setting: light / dark / system — a theme preference in Settings (persisted via `app_settings`, same pattern as other scalar settings), applied app-wide. "System" should track the OS-level `prefers-color-scheme` live (not just read once at launch); current UI presumably has only one hardcoded look today, so this needs an actual light-mode palette designed, not just a class toggle over an existing dark one.
- [x] 68. "Save as" chat export: add a PDF option alongside the existing JSON/Markdown formats (#24) — needs an actual renderer (e.g. Electron's `webContents.printToPDF()` off an HTML render of the transcript, since there's no existing PDF library in this project) rather than just extending the file-extension inference used for JSON/Markdown today.

## Testing
- [x] 57. Mocked-provider test harness (no live API calls in CI)
- [x] 58. Unit tests: provider adapters, tools, workspace guard, db repositories
- [x] 59. Integration test: full orchestrator run against a mocked provider + tool
