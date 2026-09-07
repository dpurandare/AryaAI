# Sachiv

A local-first, multi-agent AI desktop assistant (Electron + TypeScript + Svelte). See `thouthts.md` for the full spec and `TASKS.md` for what's built vs. pending.

This file is kept up to date at every stage so it always reflects what actually runs today — check the "Current state" section below before assuming a feature exists.

## Prerequisites

- Node.js 20+ and npm (developed against Node 24 / npm 11)
- macOS, Windows, or Linux
- **Linux only:** a running secret-service keyring (GNOME Keyring, KWallet, or similar) with `libsecret` installed (`libsecret-1-0` on Debian/Ubuntu, `libsecret` on Fedora/Arch). API keys are stored via Electron's `safeStorage`, which on Linux is backed by `libsecret` — without a keyring daemon running, `safeStorage.isEncryptionAvailable()` returns false and saving a key in Settings will fail with "OS-native secure storage is not available on this machine." Most desktop Linux installs (GNOME, KDE, etc.) already run one; minimal/tiling-WM setups may not and need `gnome-keyring` (or equivalent) installed and unlocked at login.

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

Work Order stages 1–5 work end to end (see `TASKS.md`):

- A window opens with a resizable session list on the left (create/switch/delete — the active session can't be deleted) and a chat pane on the right.
- Click **Settings** (bottom of the session list) to pick a provider (Anthropic or OpenAI), paste an API key, and enter a model name (e.g. `claude-sonnet-5`, `gpt-4o`) — whatever you have access to. This is stored via the OS keychain (`safeStorage`), never in a plaintext file. The provider/model choice persists across restarts.
- Type a message and hit Enter (Shift+Enter for a newline) to chat. Responses stream in live and scroll correctly once they overflow the window. Long pasted/typed messages collapse with a "Show more" toggle. Everything is persisted to a local SQLite database (`sachiv.db` under the app's userData folder) and reloads when you switch sessions or restart.
- The assistant can read/list/write files inside a dedicated workspace folder (`~/Documents/Sachiv Workspace`). Any file write asks for approval first (approve/deny/edit the JSON args, with a session-level auto-approve toggle) before it runs.
- Not yet built: the multi-agent orchestrator (routing/handoff between roles — single agent only for now), session export, context/token usage display, and Google/Ollama adapters.

This section will be updated as each Work Order stage lands, so a reviewer always knows what to actually try.

## Continuous integration

Every push to `main` and every PR runs `npm ci`, `typecheck`, and `build` on macOS, Windows, and Linux via GitHub Actions (`.github/workflows/ci.yml`). There's no automated test suite yet (`npm test` is a placeholder — see TASKS.md #57-59), so CI currently catches build/typecheck breakage, not behavioral regressions.

## Other commands

```bash
npm run typecheck   # type-check main/preload + renderer (Svelte)
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
