# Sachiv

A local-first, multi-agent AI desktop assistant (Electron + TypeScript + Svelte). See `thouthts.md` for the full spec and `TASKS.md` for what's built vs. pending.

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

Work Order stages 1–9 work end to end (see `TASKS.md`):

- A window opens with a resizable session list on the left (create/switch/delete — the active session can't be deleted) and a chat pane on the right.
- Click **Settings** (bottom of the session list) to pick a provider (Anthropic or OpenAI), paste an API key, and enter a model name (e.g. `claude-sonnet-5`, `gpt-4o`) — whatever you have access to. This is stored via the OS keychain (`safeStorage`), never in a plaintext file. The provider/model choice persists across restarts. The same panel has a **Data sources** section for adding/removing SQLite and Postgres connections the Data specialist can query.
- Type a message and hit Enter (Shift+Enter for a newline) to chat. Responses stream in live and scroll correctly once they overflow the window. Long pasted/typed messages collapse with a "Show more" toggle. Everything is persisted to a local SQLite database (`sachiv.db` under the app's userData folder) and reloads when you switch sessions or restart.
- **Multi-agent orchestrator:** the assistant can hand a step off to a specialist (Planning, Research, Coding, Terminal/DevOps, Data, Distribution) when a task fits one — shown live as a "Coding agent" (etc.) label on the attributed part of the reply. Press **Ctrl+Tab** (**Ctrl+Shift+Tab** to reverse) in the composer, or click the "Agent: ..." pill next to the model picker, to force a specific specialist instead of letting the orchestrator decide.
- **Tools**, all gated by human-in-loop confirmation for anything mutating (approve/deny/edit the JSON args, with a session-level auto-approve toggle):
  - **Files** (Coding): read/list/write inside a dedicated workspace folder (`~/Documents/Sachiv Workspace`).
  - **Shell** (Terminal/DevOps): runs a command with that workspace as `cwd` — not otherwise sandboxed, so confirmation is the real safety gate.
  - **Cloud CLIs** (Terminal/DevOps): shells out to `aws`/`az`/`gcloud` if installed and already authenticated on this machine; a clear error if not.
  - **Database** (Data): schema introspection and SQL execution against a configured SQLite or Postgres connection. Reads run immediately; writes need confirmation (and anything with more than one SQL statement is treated as a write, to be safe).
  - **Web search** (Research): DuckDuckGo's free Instant Answer API — only covers well-known topics with an existing summary, not general web search, and says so plainly when it has nothing.
- Planning and Distribution are reasoning-only for now (no tools built for them yet).
- Not yet built: session export, context/token usage display, and Google/Ollama adapters.

This section will be updated as each Work Order stage lands, so a reviewer always knows what to actually try.

## Continuous integration

Every push to `main` and every PR runs `npm ci`, `typecheck`, `build`, and `test` (Vitest) on macOS, Windows, and Linux via GitHub Actions (`.github/workflows/ci.yml`). The test suite mocks providers/SDKs — no live API calls or Electron runtime needed — and includes an integration test that runs a full `Orchestrator` turn (including delegation) against a mocked provider.

## Other commands

```bash
npm run typecheck   # type-check main/preload + renderer (Svelte)
npm test            # run the Vitest suite (mocked providers, no live API calls)
npm run build       # production build to out/
npm run dist:mac    # package a macOS installer (after build)
npm run dist:win    # package a Windows installer
npm run dist:linux  # package a Linux installer
```

## Where things live

- `src/main` — Electron main process: agents, providers, tools, db, security, IPC handlers
- `src/preload` — contextBridge-exposed API surface for the renderer
- `src/renderer` — Svelte UI
- `src/shared` — types/contracts shared across the IPC boundary
