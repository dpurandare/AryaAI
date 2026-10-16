# Sachivji Developer Guide

This folder is the documentation for people who build, extend or maintain Sachivji, one page per topic. For using the app, see the [User Guide](../user-guide/README.md).

Run `node scripts/export-docs.mjs developer --format pdf` (or `--format md`, or `npm run docs:developer`) from the repository root to join the pages into one file.

| Page | What it covers |
|---|---|
| [01 Overview](01-overview.md) | What the project is, the stack, the repository layout |
| [02 Getting started](02-getting-started.md) | Setting up, running, checking and the helper scripts |
| [03 Architecture](03-architecture.md) | Processes, IPC, storage, and one chat turn end to end |
| [04 Orchestrator and agents](04-orchestrator-and-agents.md) | Roles, the round loop, delegation, handoff and the safeguards |
| [05 Providers](05-providers.md) | The provider interface, adapters, registry and model metadata |
| [06 Tools](06-tools.md) | The tool interface, safety in code, registry and writing a tool |
| [07 Data, APIs, MCP and email](07-data-api-mcp-email.md) | Connection stores, database drivers, REST, MCP and email |
| [08 Runtime and bundling](08-runtime-and-bundling.md) | Managed Python, bundled Ollama and Node, fetch scripts |
| [09 The user interface](09-ui.md) | Svelte state, rendering safely, themes, verifying UI |
| [10 Testing](10-testing.md) | The test layers, the mock provider, evals, manual plan |
| [11 Build, release and CI](11-build-release-ci.md) | Packaging, workflows, versioning and releasing |
| [12 Conventions](12-conventions.md) | Principles, comments, security, commits, TASKS.md, docs |
| [13 Memory and search history](13-memory-and-search-history.md) | Embedding every message, the vector index, backfill, `search_history`, model changes |
| [Appendix: Extension checklists](appendix-extension-checklists.md) | Step lists for providers, tools, roles, engines, settings, IPC |

