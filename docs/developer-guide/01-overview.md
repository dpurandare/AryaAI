# 1. Overview

## What Sachivji is

Sachivji is a local-first, multi-agent desktop assistant for business and technical work. A user chats with it; an **orchestrator** answers directly or hands steps to **specialist agents** (research, code, data, documents, email and others). The agents act through **tools** (files, databases, web services, MCP servers, Office documents, Python, email). Anything that mutates asks the user first. It runs on the user's own machine (Windows, macOS, Linux) against the AI provider the user chooses.

The project began from a requirements document (`docs/thouthts.md`); the design decisions and their reasons are recorded in `docs/design-discussion.md`, and the work history is in `TASKS.md`. These two files explain *why* many things are the way they are; this guide explains *how* the code is organised and how to change it.

## Technology

| Area | Choice |
|---|---|
| Shell | **Electron** (main process, sandboxed preload, sandboxed renderer) |
| Language | **TypeScript** everywhere (ES modules) |
| Renderer | **Svelte 5** (runes), built with Vite through **electron-vite** |
| Storage | **SQLite** through `better-sqlite3`, plus the `sqlite-vec` extension for vector search |
| Providers | Official SDKs: `@anthropic-ai/sdk`, `openai` (also used for OpenAI-compatible APIs), `@google/genai`; Ollama over HTTP |
| Tools | `pg`, `mysql2`, `mssql` (databases), `nodemailer` (email), `@modelcontextprotocol/sdk` (MCP), `docx`, `docxtemplater`, `pizzip`, `exceljs`, `pptxgenjs`, `mammoth` (Office), `papaparse`, `fast-xml-parser` (data files), `jsdom` + `@mozilla/readability` (web pages) |
| Rendering | `marked` + `dompurify` (Markdown), `katex` (math), `mermaid` (diagrams) |
| Tests | **Vitest** |
| Packaging | **electron-builder** (NSIS, DMG, AppImage, deb), **electron-updater** for the update check |
| Bundled runtimes | A standalone Python, an Ollama build and Node.js, fetched per platform by scripts and shipped in the installer |

## Repository layout

```
src/
  main/        Electron main process
    agents/      orchestrator, roles, system prompt, handoff, gates, capabilities
    context/     conversation trimming to fit the model's context window
    data/        stores for database, API and email connections
    db/          SQLite: schema, sessions, messages, settings, usage, logs
    ipc/         IPC handlers (register.ts) and the turn runner (runChat)
    mcp/         MCP client, manager, config
    providers/   one adapter per AI provider behind a common interface
    roles/       user-defined role loading and the role roster
    runtime/     managed Python workspace runtime, bundled Ollama runtime
    search-history/  embedding index and the search_history tool
    security/    workspace guard, external-folder access, secret storage
    sessions/    chat export (Markdown, JSON, PDF)
    settings/    settings export/import
    tools/       every tool the agents can call (and the registry)
    window/      window bounds, zoom, context menu
  preload/     the contextBridge API exposed to the renderer (window.sachiv)
  renderer/    Svelte UI (index.html: the app; print.html: the PDF export page)
  shared/      types and contracts shared across the IPC boundary
test/support/  shared test helpers (the mock provider)
scripts/       build helpers, runtime fetchers, probes and evals, docs tooling
docs/          user guide, developer guide, design notes, manual test plan, changelog
models/        example Ollama Modelfiles
build/         icons and packaging resources
.github/workflows/   CI and release workflows
TASKS.md       the work log and backlog
```

Two build-time aliases exist: `@shared` (`src/shared`) in all three Vite targets, and `@renderer` (`src/renderer/src`) in the renderer.

## Where to start reading

1. `src/shared/ipc-contract.ts` and `src/shared/protocol.ts`: the vocabulary (channels, DTOs, stream events, content blocks).
2. `src/main/ipc/register.ts`: how requests reach the main process, and `runChat`, which runs one turn.
3. `src/main/agents/orchestrator.ts`: the heart of the app (large; see [Orchestrator and agents](04-orchestrator-and-agents.md)).
4. `src/main/tools/types.ts` and `src/main/providers/types.ts`: the two extension interfaces.
5. `src/renderer/src/App.svelte`: the single top-level UI component that owns the chat state.

## Principles the code follows

- **Enforce in code, not in prompts.** Cheap and local models ignore prompt rules, so important behaviour (validation, refusals, completion gates, loop breakers, file placement) is implemented in code, with the prompt only explaining it. See [Conventions](12-conventions.md).
- **The user is the safety gate.** A tool that mutates declares it, and the orchestrator routes the call through a confirmation before it runs.
- **Local first.** Chats, settings and the memory index are local; secrets are in the OS secure store.
- **Everything is tested without a model.** The orchestrator is tested with a scripted mock provider; nothing in `npm test` calls a real API.
