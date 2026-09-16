# Sachivji

Your local-first, multi-agent AI companion.

Built with Electron + TypeScript + Svelte. See `thouthts.md` for the full spec and `TASKS.md` for what's built vs. pending.

This file is kept up to date at every stage so it always reflects what actually runs today — check the "Current state" section below before assuming a feature exists.

## Prerequisites

- Node.js 20+ and npm (developed against Node 24 / npm 11)
- macOS, Windows, or Linux
- **Linux only:** a running secret-service keyring (GNOME Keyring, KWallet, or similar) with `libsecret` installed (`libsecret-1-0` on Debian/Ubuntu, `libsecret` on Fedora/Arch). API keys are stored via Electron's `safeStorage`, which on Linux is backed by `libsecret` — without a keyring daemon running, `safeStorage.isEncryptionAvailable()` returns false and saving a key in Settings will fail with "OS-native secure storage is not available on this machine." Most desktop Linux installs (GNOME, KDE, etc.) already run one; minimal/tiling-WM setups may not and need `gnome-keyring` (or equivalent) installed and unlocked at login.
- **Optional, only if you use the corresponding tool:** `aws`/`az`/`gcloud` on PATH and already authenticated (for the cloud CLI tools — the app doesn't manage cloud credentials itself), and a reachable Postgres server for a Postgres data connection (SQLite connections need nothing beyond a file path).

## Setup

```bash
npm install
```

If `better-sqlite3`'s native module fails to build (rare — it ships prebuilt binaries for most platforms), you'll need a C++ toolchain: Xcode Command Line Tools on macOS, `build-essential` on Linux, or Visual Studio Build Tools on Windows.

## Running in development

```bash
npm run dev
```

Opens the Electron app with hot reload on the renderer. Closing the window (or Cmd/Ctrl+Q) quits it.

## Current state (review this before testing)

The Work Order is functionally complete except code signing/notarization (blocked on the user obtaining a paid Apple Developer ID and Windows Authenticode certificate — see `TASKS.md` #11/#63-66). Everything below runs today.

- A window opens with a resizable session list on the left (create/switch/delete — the active session can't be deleted, and it auto-titles itself from your first message) and a chat pane on the right. **Light/dark/system** theme is switchable in Settings, tracking the OS preference live when set to "system."
- Click **Settings** (bottom of the session list) to pick a provider — **Anthropic, OpenAI, Google (Gemini), or Ollama** (local, no key needed) — paste an API key where one's required, and pick a model. Stored via the OS keychain (`safeStorage`), never in a plaintext file, and persists across restarts.
- Type a message and hit Enter (Shift+Enter for a newline) to chat. Responses stream in live; **multiple sessions can generate concurrently** — switching sessions or opening Settings mid-response doesn't interrupt anything, and a small activity dot marks a session still working in the background. A **Stop** button cancels an in-flight response (including one waiting on a tool confirmation); the confirmation dialog lets you edit a pending tool call's JSON before approving it. Assistant replies render Markdown (headers, bold/italic, lists, code blocks) and LaTeX math (`\(...\)`, `\[...\]`, `$$...$$`), sanitized against untrusted model/tool content. Everything persists to a local SQLite database (`sachiv.db` under the app's userData folder). **Export a session** (chat header) to Markdown, JSON, or PDF via the native save dialog.
- A **context/cost meter** in the chat status bar tracks cumulative session token usage and estimated cost against the active model's context window, with a warning past ~80%. Context is kept bounded automatically via sliding-window retention and tool-output trimming — both only affect what's sent to the provider, not what's stored or shown. A **classify-and-plan pre-pass** (toggle in Settings) detects a genuinely compound request up front and shows a live step checklist instead of running it as one undifferentiated turn.
- Full tool-call output (raw results) is **collapsed by default** to keep the transcript readable — each call shows a compact ✓/✗ once resolved. Toggle full detail on/off with the status-bar button or **Cmd+O** (macOS) / **Ctrl+O** (elsewhere), matching Claude Code's own convention; the setting persists across restarts. Live agent status while a turn is in progress shows real round-progress (e.g. "Research agent is reviewing tool results… (round 3/12)") instead of a bare "thinking."
- **Multi-agent orchestrator:** the assistant hands a step off to a specialist (Planning, Research, Coding, Terminal/DevOps, Data, Distribution) when a task fits one — shown live as a "Coding agent" (etc.) label on the attributed part of the reply. Press **Ctrl+Tab** (**Ctrl+Shift+Tab** to reverse) in the composer, or click the "Agent: ..." pill, to force a specific specialist instead of letting the orchestrator decide.
- **Tools**, all gated by human-in-loop confirmation for anything mutating (approve/deny/edit the JSON args; a session-level auto-approve toggle plus per-tool auto-approve rules persisted in Settings):
  - **Files** (Coding): read/list/write inside a configurable workspace folder (Settings > Workspace).
  - **Git & GitHub** (Coding / Distribution): `git_exec` against the workspace repo (read-only ops run free, anything that changes repo state needs confirmation) and `git_clone_repo` for inspecting a *different* repo, each clone getting its own isolated folder; `github_cli` shells out to a configured `gh` for issues/PRs/releases.
  - **Shell & cloud CLIs** (Terminal/DevOps): `shell_execute` (cwd-scoped to the workspace, not otherwise sandboxed) plus `aws_cli`/`azure_cli`/`gcloud_cli`, which shell out to an already-authenticated CLI if installed.
  - **Database** (Data): schema introspection and SQL execution against a configured SQLite or Postgres connection (Settings > Data sources). Beyond raw SQL, mechanical `db_list_rows`/`db_count_rows`/`db_find_rows` cover simple per-table lookups with no SQL needed, and the agent can save a working parametric query (`db_save_query`) as its own reusable tool for next time.
  - **External APIs** (Research): connect to and call arbitrary third-party REST APIs configured in Settings > External APIs (base URL + auth: none/API key header/bearer/basic). `api_introspect` discovers endpoints from an OpenAPI/Swagger spec, `api_call` makes an authenticated call (auto-following common pagination shapes when asked), and `api_check_status` polls an asynchronous job rather than blocking the chat turn.
  - **Structured data** (Research/Data): `parse_html` extracts clean reader-mode article text from a URL/file/inline HTML instead of the agent wading through raw markup itself; `parse_csv`/`parse_json`/`parse_xml` summarize a document's shape and support a query/filter action (plus, CSV/JSON only, appending one new record) without pulling the whole thing into context.
  - **Web search & conversation history** (Research): `web_search` uses the Tavily Search API when a key is configured (Settings > Web search) — real ranked results with independently fetchable URLs, `topic:"news"` for current-events queries — falling back to DuckDuckGo's free Instant Answer API (well-known topics only, says so plainly when it has nothing) when no key is set. `search_history` is a semantic search over your own past sessions (including the active one) so the agent can recall or compare something discussed earlier instead of guessing.
  - **MCP** (all roles): configure stdio or HTTP/SSE MCP servers in Settings — discovered tools merge into the registry automatically, live, with no restart.
- Planning is reasoning-only for now (no tools of its own).

This section will be updated as things change, so a reviewer always knows what to actually try.

## Downloads

Packaged installers are published on the [GitHub Releases](https://github.com/dpurandare/AryaAI/releases) page for macOS, Windows, and Linux.

**These builds are not yet code-signed** (no Apple Developer ID or Windows Authenticode certificate — tracked in `TASKS.md` #11/#63-66), so:

- **macOS**: Gatekeeper will call the app "unidentified" and refuse to open it normally — right-click (or Control-click) the app and choose **Open**, then confirm, to bypass this once.
- **Windows**: SmartScreen will warn "Windows protected your PC" — click **More info**, then **Run anyway**.

Neither warning means anything is broken; it's expected for an unsigned build. The app checks the Releases feed on launch and shows a banner if a newer version is available (no silent auto-install — same signing limitation).

## Continuous integration

Every push to `main` and every PR runs `npm ci`, `typecheck`, `build`, and `test` (Vitest) on macOS, Windows, and Linux via GitHub Actions (`.github/workflows/ci.yml`). The test suite mocks providers/SDKs — no live API calls or Electron runtime needed — and includes an integration test that runs a full `Orchestrator` turn (including delegation) against a mocked provider.

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds installers for all 3 platforms and uploads them to a **draft** GitHub Release for manual review before publishing.

## Other commands

```bash
npm run typecheck   # type-check main/preload + renderer (Svelte)
npm test            # run the Vitest suite (mocked providers, no live API calls)
npm run build       # production build to out/
npm run dist:mac    # package a macOS installer (after build)
npm run dist:win    # package a Windows installer
npm run dist:linux  # package a Linux installer
```

## Versioning

Sachivji follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`). While the major version is `0`, any release may include breaking changes. From `1.0.0` onward: `MAJOR` is reserved for breaking changes to stored data, config, or IPC contracts; `MINOR` for backward-compatible features; `PATCH` for fixes. See `CHANGELOG.md` for release notes.

## Where things live

- `src/main` — Electron main process: agents, providers, tools, db, security, IPC handlers
- `src/preload` — contextBridge-exposed API surface for the renderer
- `src/renderer` — Svelte UI
- `src/shared` — types/contracts shared across the IPC boundary
