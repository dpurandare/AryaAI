# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/) — see the
Versioning section in `README.md` for what that means while the major
version is still `0`.

## [Unreleased]

### Added

- Rebranded from "Sachiv" to "Sachivji" everywhere user-facing, including the dev-mode Electron process/Dock identity (packaged builds were already correctly named).
- Real app icon (gear + person silhouette + capability badges), replacing the placeholder monogram.
- Widened providers: Google (Gemini) and Ollama (local, no key needed) adapters, behind a provider registry so adding one needs no renderer changes.
- Widened tools: `git_exec`/`git_clone_repo`, `github_cli`, MCP client (stdio + HTTP/SSE, live tool-registry merge), `search_history` (cross-session semantic recall), mechanical DB CRUD tools (`db_list_rows`/`db_count_rows`/`db_find_rows`) and agent-authored parametric saved queries (`db_save_query`), and a generic external-API access tool (`api_list_connections`/`api_introspect`/`api_call`/`api_check_status` — introspection via OpenAPI/Swagger, authenticated calls, automatic pagination, async job-status polling).
- Real per-provider token counting and cost estimation, a context/cost meter in the UI, sliding-window context retention, and tool-output trimming.
- Cancellation (Stop button, including mid-confirmation) and mid-run steering (edit a pending tool call before approving it).
- Multi-session concurrency — sessions can generate in the background independently; switching sessions or opening Settings no longer interrupts anything.
- A classify-and-plan pre-pass that detects a compound request up front and shows a live step checklist.
- Session auto-titling from the first message; PDF added alongside Markdown/JSON session export.
- Light/dark/system theme setting, tracking the OS preference live.
- Markdown and LaTeX math rendering for assistant messages, sanitized against untrusted content.
- Structured data-processing tools for HTML/CSV/JSON/XML, so an agent processes a large or raw document itself instead of pulling it into its own context.

### Fixed

- A real launch-blocking bug in the first-ever packaged build: `sqlite-vec`'s native binary couldn't load from inside the asar archive.
- `electron-updater`'s ESM/CJS interop crash in a packaged build.
- `message_vectors` orphans left behind on session deletion.
- Three rounds of `search_history` relevance bugs (own-result reindexing, whole-message-granularity retrieval, no relevance floor on results).
- Reasoning models (gpt-oss, o1/o3-style) silently producing empty replies by starving on a flat 4096-token output cap — real per-model ceilings now apply.
- The local classify-and-plan call producing invalid JSON once a conversation already had a prior tool-use turn, by isolating it to the latest message only.
- Dock hover-tooltip showing "Electron" instead of "Sachivji" in dev mode (root cause: the `.app` bundle folder's own filename, not any Info.plist key) — and, in the same pass, reverted an earlier attempted fix for this that had silently broken `npm run dev`'s live renderer (an executable-file rename tripped Electron's own hardcoded `app.isPackaged` check, so dev launches silently served a stale prebuilt bundle instead of the live Vite dev server with no error anywhere).
- The context meter's window figure for a local model was wrong far more often than not: it was tied to sending a new message rather than the current provider/model choice (so simply opening an existing session kept showing a stale guess), and had no fallback for the common case of Ollama having idled the model out of VRAM between messages. Now refreshes proactively on load/model-change and falls back to the model's *configured* context (its Modelfile's own `num_ctx`) before the generic static guess.
- `parse_html` discarded every link on a page, so fetching a listing/topic page left the model with nothing but headline text — it would fabricate a plausible-looking article URL to follow up with, which predictably 404'd. Now also lists the page's real links. Also: the data-format tools' shared source resolution no longer rejects a call where a model filled in every schema field (`url` plus empty-string `filePath`/`text`) instead of omitting the ones it didn't use.

## [0.1.0] - 2026-09-08

### Added

- Electron + TypeScript + Svelte 5 desktop app scaffold, with `contextIsolation`/`sandbox` renderer hardening and typed IPC.
- Embedded SQLite persistence for sessions and messages; OS-keychain-backed credential store for API keys and data-connection secrets.
- Multi-provider chat (Anthropic, OpenAI, Google, Ollama) behind a unified provider adapter, with runtime provider/model switching.
- Multi-agent orchestrator (Planning, Research, Coding, Terminal/DevOps, Data, Distribution) with delegation-as-tool-call routing and live agent attribution in the UI.
- Tool suite with human-in-loop confirmation for mutating calls: file operations, shell execution, database access (schema introspection + generated SQL), AWS/Azure/GCP CLI tools, git operations, and the GitHub CLI (`gh`).
- MCP client (stdio and HTTP/SSE transports) with server configuration UI, merging discovered tools into the shared tool registry.
- Context/token-usage tracking with real-time cost estimation, a context meter in the UI, tool-output trimming, and sliding-window conversation retention.
- Cancellation (stop an in-flight response) and mid-run steering (edit a pending tool call before it executes).
- Session lifecycle: new session, delete (blocked for the active session), export to Markdown or JSON via native save dialog.
- Markdown rendering for assistant messages (headers, bold/italic, lists, code blocks), sanitized against untrusted model/tool output.
- Cross-platform CI (build, typecheck, test on macOS/Windows/Linux) via GitHub Actions.

[Unreleased]: https://github.com/dpurandare/AryaAI/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dpurandare/AryaAI/releases/tag/v0.1.0
