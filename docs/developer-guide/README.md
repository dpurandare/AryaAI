# Sachivji Developer Guide

This folder is the documentation for people who build, extend or maintain Sachivji, one page per topic. For using the app, see the [User Guide](../user-guide/README.md).

Run `node scripts/export-docs.mjs developer --format pdf` (or `--format md`, or `npm run docs:developer`) from the repository root to join the pages into one file.

| Page | What it covers |
|---|---|
| [01 Overview](01-overview.md) | What the project is, the stack, the repository layout |
| [02 Getting started](02-getting-started.md) | Setting up, running, checking and the helper scripts |
| [03 Architecture](03-architecture.md) | Processes, IPC, storage, and one chat turn end to end |

Planned (see `docs/docs-outline.md`; numbers are fixed): 04 orchestrator and agents, 05 providers, 06 tools, 07 data, API, MCP and email, 08 runtime and bundling, 09 UI, 10 testing, 11 build, release and CI, 12 conventions, and an appendix of extension checklists.
