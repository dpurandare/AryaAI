# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/) — see the
Versioning section in `README.md` for what that means while the major
version is still `0`.

## [Unreleased]

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
