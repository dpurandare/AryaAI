# Sachiv

A local-first, multi-agent AI desktop assistant (Electron + TypeScript + Svelte). See `thouthts.md` for the full spec and `TASKS.md` for what's built vs. pending.

This file is kept up to date at every stage so it always reflects what actually runs today — check the "Current state" section below before assuming a feature exists.

## Prerequisites

- Node.js 20+ and npm (developed against Node 24 / npm 11)
- macOS, Windows, or Linux

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

The core single-agent chat loop works end to end (Work Order stages 1–4, see `TASKS.md`):

- A window opens with a session list on the left (create/switch/delete — the active session can't be deleted) and a chat pane on the right.
- Click **Settings** (bottom of the session list) to pick a provider (Anthropic or OpenAI), paste an API key, and enter a model name (e.g. `claude-sonnet-5`, `gpt-4o`) — whatever you have access to. This is stored via the OS keychain (`safeStorage`), never in a plaintext file. The provider/model choice persists across restarts.
- Type a message and hit Enter (Shift+Enter for a newline) to chat. Responses stream in live. Everything is persisted to a local SQLite database (`sachiv.db` under the app's userData folder) and reloads when you switch sessions or restart.
- Not yet built: tools/agents (the assistant can only talk, not act), session export, context/token usage display, and Google/Ollama adapters.

This section will be updated as each Work Order stage lands, so a reviewer always knows what to actually try.

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
