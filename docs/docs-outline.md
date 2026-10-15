# Reference documentation — outline (TASKS #92)

**Status (2026-10-15): outline agreed; export script built; the whole User Guide text is written (pages 01-13, tool catalog and glossary) with 20 generated screenshots.** Still open for the User Guide: the hand-taken screenshots (TASKS #213) and your review. The Developer Guide is not started. The numbering was changed on 2026-10-15 (06 your own roles, 07 memory across chats). Every claim was checked against the code as it was written.

## Decisions (2026-10-15)

- **Two separate documents**: a **User Guide** (people you share the app with) and a **Developer Guide** (people extending or maintaining it).
- **Markdown folders in the repo**: `docs/user-guide/` and `docs/developer-guide/`, one page per topic, numbered file names so the order is fixed, each folder with a `README.md` index.
- **Export script** `scripts/export-docs.mjs`: `node scripts/export-docs.mjs user|developer [--format md|pdf] [--out <file>]` joins the pages in order into one Markdown file, or renders a PDF from it (reusing the Electron/`printToPDF` approach already used for chat export, so no new dependency). Also emits a table of contents. Later: Word via the same joined Markdown if wanted.
- `README.md` stays a short quickstart that links to both guides; `docs/design-discussion.md`, `manual_testing.md` and `TASKS.md` stay as internal records.

## 1. User Guide (`docs/user-guide/`)

| File | Contents | Main sources to check against |
|---|---|---|
| `01-introduction.md` | What Sachivji is, what it can and cannot do, how it differs from a plain chatbot; a 5-minute tour | README "Current state", `docs/thouthts.md` |
| `02-install-and-first-run.md` | Install per OS (Windows installer, macOS dmg, Linux AppImage/deb), SmartScreen / Gatekeeper warnings, first-run steps (credential storage, Python, local embeddings), what is bundled, updating, uninstalling | `windows_install.md`, `windows_cleanup.md`, `docs/prerequisites.md`, `electron-builder.yml`, `FirstRunSetup.svelte` |
| `03-providers-and-keys.md` | Choosing a provider and model (OpenAI, Anthropic, Google, Groq, Mistral, Ollama, OpenAI-compatible), getting and storing keys, cost/context meter, prompt caching, temperature/model behaviour, picking a small vs large model | `src/main/providers/*`, Settings > Provider API keys / Model behavior / Prompt caching |
| `04-using-the-chat.md` | Sessions (create, switch, search, delete, titles), composer, Stop, steering a running task with a note, tool confirmation dialog (approve / deny / edit / comment), auto-approve, tool-output display modes (`Cmd/Ctrl+O`), reasoning display, keyboard shortcuts, zoom, export to Markdown / JSON / PDF (images included) | `ChatView.svelte`, `SessionList.svelte`, `ToolConfirmDialog.svelte`, `ContextMeter.svelte`, `session export` |
| `05-agents-and-roles.md` | The orchestrator and the specialists: Planner, Researcher, History Analyst, Developer, Data Access, Data Processor, Text Document Creator, Configurator, MCP Operator, Page Creator, Email — what each does, example requests, the Agent picker (pin a specialist), plans and step checklist (writing your own roles has its own page, 06) | `src/shared/agents.ts` (`ROLE_MANIFEST`), `src/main/agents/*`, `src/main/roles/*` |
| `06-your-own-roles.md` | **Defining and using your own roles** (added 2026-10-15): what a role is and when to make one; the roles folder and the example file; every frontmatter field with limits (`id`, `name`, `summary`, `description`, `examples`, `notExamples`, `tools`, `maxRounds`, `isolated`, `pickable`, `plannable`) and the prompt body; choosing tools (exact names, `prefix*` patterns, the Settings list of tools by role); how to write a routing summary that works (says what it does NOT do and names the role that does; the warnings explained); how roles are used (the assistant routes to them from the summary, pin with the Agent picker, multi-step plans); enable/disable, reload, problems and last-working-version, limits (20 roles, token cost per request); a worked example; safety (a role cannot grant itself anything, confirmations still apply); common mistakes | `src/shared/role-file.ts`, `role-lint.ts`, `src/main/roles/*`, Settings > Roles and Tools by role |
| `07-memory-across-chats.md` | **Memory across chats** (added 2026-10-15): how every message is indexed into a local vector database as you chat; searching past conversations by meaning; the History Analyst; recall, compare and "what changed since" requests with example prompts; the current chat is searchable too; what is and is not indexed (text excerpts, not whole-session state); the index status and Rebuild button in Settings; changing the embedding model requires a rebuild; the caveat that old statements may be out of date; offline / Ollama requirements; what is not built yet (a Cmd+F style text search across the session list, #189/#190) | `src/main/search-history/*` (`tool.ts`, `indexer.ts`, `chunk-text.ts`), `ROLE_MANIFEST` History Analyst, Settings > Search History Embedding, `ollama-runtime.ts` |
| `08-working-with-files-and-documents.md` | The workspace folder and its layout (`code/ documents/ resources/ venv/`), folders outside the workspace, reading/writing files, Word/Excel/PowerPoint creation, templates, decks and stock images, PDF handling, charts via Python | `src/main/tools/file-ops.ts`, `workspace-layout.ts`, `office-docs/*`, `deck/*`, `python-run.ts` |
| `09-connecting-data-and-services.md` | Databases (SQLite, Postgres), external REST APIs, MCP servers (write the one-line description), email accounts, web search provider (Tavily / DuckDuckGo), search-history embeddings; how to ask the assistant to set each up, with worked examples (Context7, Open-Meteo, the sample wind/solar DB) | `src/main/data/*`, `tools/db`, `tools/api`, `mcp/*`, `tools/email`, `windows_install.md` examples |
| `10-settings-reference.md` | Every Settings section, in screen order, each option with its default and effect: Appearance, Orchestrator, Transcript, Provider keys, Data sources, Search History Embedding, Web Search, MCP servers, External APIs, Email, Workspace, Python runtime, Local embeddings, Roles, Tools by role, Slim router, Prompt caching, Model behavior, Auto-approve rules, Secret storage; settings export/import (what is and is not exported) | `SettingsPanel.svelte`, `src/main/settings/*` |
| `11-security-and-privacy.md` | What leaves your machine (prompts to the chosen provider, web search queries), where data lives (local SQLite, OS keychain), confirmation on every mutating action, the workspace boundary, untrusted tool/MCP text, what the app never does without asking | `src/main/security/*`, `README` |
| `12-troubleshooting.md` | Common problems and fixes: first-launch retries, Python repair, embedding model missing, provider 400/429 errors, rate limits, a tool looping, Ollama not reachable, SmartScreen/Gatekeeper, resetting a profile, where the logs are | `README` Troubleshooting, TASKS #202 findings, `windows_cleanup.md` |
| `13-faq-and-tips.md` | Prompting tips for each kind of task, which model for what, cost control, typical recipes (top-N report to Word, research to deck, charts from a DB) | session experience, `manual_testing.md` scenarios |
| `appendix-tool-catalog.md` | Every tool by category with a one-line purpose, whether it asks for confirmation, and which roles hold it | tool registry, `capabilities.ts` (ideally **generated** by the export script from the registry so it cannot go stale) |
| `appendix-glossary.md` | Orchestrator, specialist, handoff, plan step, MCP, workspace, venv, embedding, context window, … | — |

## 2. Developer Guide (`docs/developer-guide/`)

| File | Contents | Main sources to check against |
|---|---|---|
| `01-overview.md` | Purpose, tech stack (Electron, Svelte 5, TypeScript, SQLite, Python runtime), repo layout, glossary | `package.json`, `src/*` |
| `02-getting-started.md` | Clone, prerequisites, `npm install`, dev run, typecheck, tests, the scripts in `scripts/`, running with a throwaway profile (`--user-data-dir`, `SACHIV_WORKSPACE_DIR`) | `README`, `manual_testing.md` section 10 |
| `03-architecture.md` | Main / preload / renderer split, IPC contract (`ipc-contract.ts`), session and message storage, streaming events (`protocol.ts`), data flow of one chat turn | `src/main/ipc`, `src/shared/*`, `src/preload` |
| `04-orchestrator-and-agents.md` | Orchestrator loop, classify-and-plan, delegation and typed handoff, role manifest and tool access, context handling and trimming, restatement/knowledge-first/completion gates, loop breakers, router prompt budget | `src/main/agents/*`, `src/main/context/*`, `docs/design-discussion.md` |
| `05-providers.md` | The provider interface, each adapter, the registry, rate limiting, caching, adding a provider (checklist) | `src/main/providers/*` |
| `06-tools.md` | Tool interface and registry, confirmation / mutation flags, workspace guard, adding a tool (checklist + test pattern), prompt-budget tests | `src/main/tools/*`, `security/*` |
| `07-data-api-mcp-email.md` | Connection stores, DB engines and adding one (#76), API connections and auth, MCP client (stdio/HTTP, bundled Node), email accounts | `src/main/data`, `mcp`, `tools/email` |
| `08-runtime-and-bundling.md` | Managed Python runtime and venv, bundled Python / Ollama / Node per OS and the `scripts/fetch-bundled-*` scripts, embeddings, search-history index | `src/main/runtime`, `search-history`, `scripts/` |
| `09-ui.md` | Svelte components, state conventions (runes gotchas), theming, print/PDF page, keyboard shortcuts | `src/renderer/*` |
| `10-testing.md` | Unit tests (vitest), mocks for Electron, the manual test plan, routing eval, cache probe, role probe, verifying UI changes live (throwaway profile + CDP) | `test/`, `docs/manual_testing.md`, `scripts/*.mts` |
| `11-build-release-ci.md` | `dist:*` scripts, per-platform bundles, `release.yml` and the on-demand dist workflows, manual-only CI, versioning (0.3.x patches / 0.4.0 features), changelog, signing status | `electron-builder.yml`, `.github/workflows/*`, `docs/CHANGELOG.md` |
| `12-conventions.md` | Commit and TASKS conventions, enforce-in-code-not-prompts principle, cross-platform rules, security rules | `TASKS.md`, project memory notes |
| `appendix-extension-checklists.md` | Step lists: add a provider, a tool, a role, a DB engine, a setting, an IPC channel | derived from the pages above |

## 3. Work plan

1. **You review this outline** (add/remove/reorder; tell me anything that must be in the first release of the docs).
2. I build the **export script** and the two folder skeletons with the index pages, so a combined Markdown / PDF can be produced from day one.
3. Write the **User Guide first** (it is what you share): pages 01–04 (done), then 05–10, then 11–13 and the appendices. After each batch I check the text against the code and run the app for anything I'm unsure about; you read and correct.
4. Write the **Developer Guide** (much of it can be lifted and verified from `docs/design-discussion.md` and TASKS).
5. Keep it current: a TASKS convention that a user-visible change updates the matching page; the tool catalog and settings tables are generated or checked by a test where possible.

## Open questions

- Screenshots in the User Guide? (Useful, but they go stale; I can add placeholders and you supply them, or I capture them from the running app.)
- Release the docs inside the app (a Help menu entry opening the User Guide) as a later step?
- Name of the product in the docs: "Sachivji" throughout? (The window and installer say Sachivji; some code and the older DMG say Sachiv.)
