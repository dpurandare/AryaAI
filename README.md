# Sachivji

Your local-first, multi-agent AI companion.

Built with Electron + TypeScript + Svelte. See `docs/thouthts.md` for the full spec and `TASKS.md` for what's built vs. pending.

This file is kept up to date at every stage so it always reflects what actually runs today — check the "Current state" section below before assuming a feature exists.

## Prerequisites

- **Node.js 22+ (developed/tested against Node 24 / npm 11) — not 20.** Found live on a fresh Linux install: `better-sqlite3`'s prebuilt native binary (and several other deps — `electron`, `jsdom`, `vitest`) declare `engines: { node: ">=22" }` for real, not as a formality. Under Node 20, `better-sqlite3`'s bundled binary **segfaults the process** as soon as a database is opened (confirmed directly 2026-10-16: `new (require('better-sqlite3'))(':memory:')` crashes with `Segmentation fault (core dumped)`; merely `require`-ing it does not), not a catchable JS error. Node 22 was also checked: typecheck clean, all 1,650 tests pass. `npm install` itself succeeds either way — it only warns (`EBADENGINE`) — so this won't be obvious until the app actually touches its database. Use `nvm install 24 && nvm alias default 24` (or your version manager's equivalent) if you're not already on 22+.
- macOS, Windows 11, or Linux
- **Windows 11 (x64 or ARM64): see [`docs/prerequisites.md`](docs/prerequisites.md)** for the full list, and run `scripts\install-prerequisites.cmd` (add `-All` for the optional tools) to install and verify them with winget.
- **Python 3.10 to 3.13, with `venv` support** (3.14 is not supported yet: the pinned `numpy` has no wheel for it). Sachivji runs agent-written scripts (charts, Word/Excel files) in a virtual environment it creates in your workspace (`<workspace>/venv`) on first start, installing a small pinned set of packages (matplotlib, numpy, pillow, python-docx, openpyxl; needs network access once). Windows: install from [python.org](https://www.python.org/downloads/) with the `py` launcher; macOS: `brew install python` or the python.org installer (the Xcode Command Line Tools' Python is too old); Debian/Ubuntu: `sudo apt install python3 python3-venv`. The app checks for Python itself and shows its state in **Settings > Runtime** (Retry / Repair / Turn Python off); without Python everything except running scripts still works. An existing `venv/` in the workspace is used as-is. A virtual environment is **not a sandbox**.
- **Linux only: Ubuntu 22.04 LTS or newer** (or an equivalent glibc ≥ 2.34). This comes from `better-sqlite3`'s own published native addon, not from the bundled Python/Ollama/Node runtime (which all need less) — confirmed by downloading the pristine `better-sqlite3` npm package directly and checking its shipped `prebuilds/linux-x64.node`, independent of any build machine. An older glibc (e.g. Ubuntu 20.04, glibc 2.31) can still run a build *rebuilt from source* against an older toolchain, but that's not what a clean `npm ci` + package produces, so it's not what's distributed from CI.
- **Linux only:** a running secret-service keyring (GNOME Keyring, KWallet, or similar) with `libsecret` installed (`libsecret-1-0` on Debian/Ubuntu, `libsecret` on Fedora/Arch). API keys are stored via Electron's `safeStorage`, which on Linux is backed by `libsecret` — without a keyring daemon running, `safeStorage.isEncryptionAvailable()` returns false and saving a key in Settings will fail with "OS-native secure storage is not available on this machine." Most desktop Linux installs (GNOME, KDE, etc.) already run one; minimal/tiling-WM setups may not and need `gnome-keyring` (or equivalent) installed and unlocked at login.
- **Linux only, dev (`npm run dev`/`npm start`):** on some distros (Ubuntu 24.04+ and others restricting unprivileged user namespaces) Electron's sandbox needs a one-time permissions fix or it refuses to launch — see [Troubleshooting](#troubleshooting) below if you hit a `SUID sandbox helper binary` error.
- **Optional, only for the matching feature:** `git` and `gh` (git / GitHub tools); `aws` / `az` / `gcloud`, already signed in (cloud tools; the app does not manage cloud credentials); a reachable Postgres, MySQL or SQL Server for a database connection (SQLite needs only a file path); and [Ollama](https://ollama.com) with `ollama pull nomic-embed-text` for `search_history` (Settings > Search history can use another embedding provider instead). Without these the feature reports why it is off; everything else works.

## Setup

```bash
npm install
```

If `better-sqlite3`'s native module fails to build (rare — it ships prebuilt binaries for most platforms), you'll need a C++ toolchain: Xcode Command Line Tools on macOS, `build-essential` on Linux, or Visual Studio Build Tools on Windows.

Electron's own binary is downloaded lazily on first launch (`npm run dev`/`npm start`), not during `npm install` — this app's `postinstall` script triggers that download eagerly instead, so the first `npm install` after cloning (or any `rm -rf node_modules && npm install`) does the ~150-200MB download up front rather than surprising you on first launch.

## Running in development

```bash
npm run dev
```

Opens the Electron app with hot reload on the renderer. Closing the window (or Cmd/Ctrl+Q) quits it.

## Troubleshooting

**`npm run dev` / `npm start` aborts with:**

```
FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:...] The SUID sandbox helper binary was found,
but is not configured correctly. Rather than run without sandboxing I'm aborting now. You need to make
sure that .../node_modules/electron/dist/chrome-sandbox is owned by root and has mode 4755.
```

Linux only. Newer distros (Ubuntu 24.04+ and others) restrict unprivileged user namespaces via AppArmor by default — check with `cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns` (`1` means restricted). Electron falls back to its classic setuid-root sandbox helper in that case, but a freshly-downloaded `chrome-sandbox` binary is owned by your own user, not root, so Electron refuses to run unsandboxed rather than silently weakening security. Fix:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

This resets every time `npm install` re-downloads Electron (including a clean `rm -rf node_modules && npm install`), so redo it after one of those if the error comes back. Only affects unpackaged dev runs — the packaged AppImage/deb (`npm run dist:linux`) is unaffected either way.

**Chatting with an Ollama (local) model, it forgets things or the context/cost meter shows a surprisingly small number (often ~4K), even though the model's page advertises a much bigger context window (e.g. 128K):**

Ollama loads a model with a small runtime context window by default — commonly 4096 tokens — regardless of that model's real architectural maximum, unless told otherwise. `gpt-oss:20b` advertises 131072 but is actually *loaded* at 4096 out of the box, confirmed live. This app reads the model's real, currently-loaded context straight from Ollama and budgets conversation history against that live number (`src/main/providers/ollama.ts`'s `loadedContextWindow`/`configuredContextWindow`, used by `resolveContextWindow`) rather than assuming the bigger advertised figure — so the small number you're seeing is Ollama's actual runtime setting, not a bug in the meter.

Fix: create a custom model with a larger `num_ctx` baked in via a Modelfile, then use that custom model instead of the base one. Two working examples already live in the `models/` folder:

```
# ModelFile — gpt-oss:20b with a 128K context window
FROM gpt-oss:20b
PARAMETER num_ctx 131072
```

```
# ModelFile2 — qwen3.8:latest with a 256K context window
FROM qwen3.8:latest
PARAMETER num_ctx 262144
```

Build and select one:

```bash
ollama create gpt-oss-custom -f ./models/ModelFile      # or: ollama create qwen3.8-custom -f ./models/ModelFile2
```

Then pick the new `gpt-oss-custom` (or `qwen3.8-custom`) entry as the model in Settings, same as any other Ollama model — nothing else in the app needs configuring. It'll show up in Ollama's model list (`ollama list`) as its own separate model, several GB of disk space per variant (it's a full copy, not a lightweight alias), and the context/cost meter will immediately reflect the real, larger `num_ctx` you set, whether the model is currently loaded or idled out of VRAM (Ollama's default when nothing's been sent in a while).

Adjust `num_ctx` to whatever the base model actually supports and your available VRAM allows — a larger context window uses proportionally more memory when the model is loaded. `PARAMETER num_parallel N` (commented out in both example files) trades concurrent-request capacity for per-request context if you ever run multiple chats against the same loaded model at once.

## Current state (review this before testing)

The Work Order is functionally complete except code signing/notarization (blocked on the user obtaining a paid Apple Developer ID and Windows Authenticode certificate — see `TASKS.md` #11/#63-66). Everything below runs today.

- A window opens with a resizable session list on the left (create/switch/delete — the active session can't be deleted, and it auto-titles itself from your first message) and a chat pane on the right. **Light/dark/system** theme is switchable in Settings, tracking the OS preference live when set to "system."
- Click **Settings** (bottom of the session list) to pick a provider — **Anthropic, OpenAI, Google (Gemini), or Ollama** (local, no key needed) — paste an API key where one's required, and pick a model. Stored via the OS keychain (`safeStorage`), never in a plaintext file, and persists across restarts.
- Type a message and hit Enter (Shift+Enter for a newline) to chat. Responses stream in live; **multiple sessions can generate concurrently** — switching sessions or opening Settings mid-response doesn't interrupt anything, and a small activity dot marks a session still working in the background. A **Stop** button cancels an in-flight response (including one waiting on a tool confirmation); the confirmation dialog lets you edit a pending tool call's JSON before approving it. Assistant replies render Markdown (headers, bold/italic, lists, code blocks) and LaTeX math (`\(...\)`, `\[...\]`, `$$...$$`), sanitized against untrusted model/tool content. Everything persists to a local SQLite database (`sachiv.db` under the app's userData folder). **Export a session** (chat header) to Markdown, JSON, or PDF via the native save dialog.
- A **context/cost meter** in the chat status bar tracks cumulative session token usage and estimated cost against the active model's context window, with a warning past ~80%. Context is kept bounded automatically via sliding-window retention and tool-output trimming — both only affect what's sent to the provider, not what's stored or shown. A **classify-and-plan pre-pass** (toggle in Settings) detects a genuinely compound request up front and shows a live step checklist instead of running it as one undifferentiated turn.
- Full tool-call output (raw results) is **collapsed by default** to keep the transcript readable — each call shows a compact ✓/✗ once resolved. Toggle full detail on/off with the status-bar button or **Cmd+O** (macOS) / **Ctrl+O** (elsewhere), matching Claude Code's own convention; the setting persists across restarts. Live agent status while a turn is in progress shows real round-progress (e.g. "Research agent is reviewing tool results… (round 3/12)") instead of a bare "thinking."
- **Multi-agent orchestrator:** the assistant hands a step off to a specialist (Planner, Researcher, History Analyst, Developer, Data Access, Data Processor, Document Creator, Configurator, Email) when a task fits one — shown live as a "Developer agent" (etc.) label on the attributed part of the reply. Press **Ctrl+Tab** (**Ctrl+Shift+Tab** to reverse) in the composer, or click the "Agent: ..." pill, to force a specific specialist instead of letting the orchestrator decide. In Auto mode the top-level orchestrator is not limited to routing — it holds the *entire* tool registry directly (every specialist's tools, unfiltered) and can act on a simple request itself rather than always delegating, deliberately: a one-off tool call doesn't need a delegation round-trip. Delegation is for when a task is substantial enough to benefit from a specialist's own focused prompt and round budget, not the only path to any given tool.
- **Tools**, all gated by human-in-loop confirmation for anything mutating (approve/deny/edit the JSON args; a session-level auto-approve toggle plus per-tool auto-approve rules persisted in Settings):
  - **Files** (Developer; Data Processor and Document Creator can read them): read/list/write inside a configurable workspace folder (Settings > Workspace).
  - **Git & GitHub** (Developer): `git_exec` against the workspace repo (read-only ops run free, anything that changes repo state needs confirmation) and `git_clone_repo` for inspecting a *different* repo, each clone getting its own isolated folder; `github_cli` shells out to a configured `gh` for issues/PRs/releases.
  - **Shell, Python & cloud CLIs** (Developer — it writes *and* runs code, so a script is written and executed by the same specialist, with the workspace's Python environment active): `shell_execute` (cwd-scoped to the workspace, not otherwise sandboxed) plus `aws_cli`/`azure_cli`/`gcloud_cli`, which shell out to an already-authenticated CLI if installed.
  - **Database** (Data Access): schema introspection and SQL execution against a configured SQLite or Postgres connection (Settings > Data sources). Beyond raw SQL, mechanical `db_list_rows`/`db_count_rows`/`db_find_rows` cover simple per-table lookups with no SQL needed, and the agent can save a working parametric query (`db_save_query`) as its own reusable tool for next time.
  - **External APIs** (Data Access): connect to and call arbitrary third-party REST APIs configured in Settings > External APIs (base URL + auth: none/API key header/bearer/basic). `api_introspect` discovers endpoints from an OpenAPI/Swagger spec, `api_call` makes an authenticated call (auto-following common pagination shapes when asked), and `api_check_status` polls an asynchronous job rather than blocking the chat turn.
  - **Structured data** (Researcher: `parse_html`; Data Processor: `parse_csv`/`parse_json`/`parse_xml`): `parse_html` extracts clean reader-mode article text from a URL/file/inline HTML instead of the agent wading through raw markup itself; `parse_csv`/`parse_json`/`parse_xml` summarize a document's shape and support a query/filter action (plus, CSV/JSON only, appending one new record) without pulling the whole thing into context.
  - **Web search & conversation history** (Researcher: `web_search`; History Analyst: `search_history`): `web_search` uses the Tavily Search API when a key is configured (Settings > Web search) — real ranked results with independently fetchable URLs, `topic:"news"` for current-events queries — falling back to DuckDuckGo's free Instant Answer API (well-known topics only, says so plainly when it has nothing) when no key is set. `search_history` is a semantic search over your own past sessions (including the active one) so the agent can recall or compare something discussed earlier instead of guessing — needs the embedding prerequisite above; Settings > Search history shows its live status.
  - **MCP** (MCP Operator specialist; the top-level assistant also carries them unless the experimental slim router is on): configure stdio or HTTP/SSE MCP servers in Settings — discovered tools are wired in live, with no restart, and belong to the **MCP Operator** alone, so a server with many tools adds nothing to any other request and a data or coding task can no longer reach a wiki's write tools by accident. Write a one-line description of each server (Settings > MCP servers): that line — not the server's own text — is what the assistant uses to pick a server. A server's own tool descriptions are length-capped and labelled as untrusted third-party text. Server-authored handshake `instructions` are not injected anywhere.
- **Your own roles:** drop a Markdown file with frontmatter (`id`, `name`, `summary`, `examples`, `tools`, …) and the role's prompt as the body into `<userData>/roles/` (Settings > Roles opens the folder and writes an example). It appears in the Agent picker and to the assistant on your next message. It can only select existing tools — confirmation and the workspace boundary still apply. Built-in ids cannot be reused.
- The Planner is reasoning-only (no tools of its own). Connections (databases, external APIs, MCP servers) are set up by the Configurator; Word/Office documents are created by the Document Creator.

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

Sachivji follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`). While the major version is `0`, any release may include breaking changes. From `1.0.0` onward: `MAJOR` is reserved for breaking changes to stored data, config, or IPC contracts; `MINOR` for backward-compatible features; `PATCH` for fixes. See `docs/CHANGELOG.md` for release notes.

## Documentation

- **[User Guide](docs/user-guide/README.md)** — installing, using and configuring Sachivji (for people who use it).
- **[Developer Guide](docs/developer-guide/README.md)** — architecture, extending and releasing (for people who change it).
- Each guide can be exported as one Markdown file or PDF: `npm run docs:user`, `npm run docs:developer` (output in `release/`).

## Where things live

- `src/main` — Electron main process: agents, providers, tools, db, security, IPC handlers
- `src/preload` — contextBridge-exposed API surface for the renderer
- `src/renderer` — Svelte UI
- `src/shared` — types/contracts shared across the IPC boundary
- `docs/` — design notes, the original spec (`thouthts.md`), manual test plan, changelog, Windows prerequisites
- `models/` — example Ollama Modelfiles with larger context windows (see Troubleshooting above)
- `scripts/` — build/dev helpers, probes and evals, and the Windows prerequisites installer
- `test/support` — shared test helpers (the mock provider)
