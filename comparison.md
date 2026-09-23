# Sachivji vs. OpenClaw

A factual comparison based on this repository's own code (`src/main/agents/roles.ts`, `src/main/tools/`, `README.md`) and OpenClaw's public README, docs, and architecture pages (see Sources). Where a claim about OpenClaw depends on its docs rather than hands-on testing, it's phrased as "not a documented built-in" rather than an absolute "cannot" — see the note at the end on why that distinction matters here.

## What Sachivji does that OpenClaw does not (or not out of the box)

1. **A fixed roster of named specialist agents with automatic request decomposition.** Sachivji's orchestrator classifies a request as simple or compound and, for compound requests, builds an ordered plan across named specialists (Research, Coding, Data, Terminal/DevOps, Distribution, Email, Planning, Page-Creator), each with its own curated tool subset and tuned system prompt. OpenClaw has a generic subagent primitive (`subagents`, `agents_list`, `agents_wait`) for spawning and coordinating agents, but no predefined "who's good at what" roster or automatic compound-request decomposition.
2. **Native, richly-formatted Office document generation, built into the core app.** `.docx` with real Word headings, tables, bulleted/numbered lists, and inline bold/italic/code formatting; `.pptx` slide decks via a dedicated composition flow; `.xlsx` with bold/shaded headers, real cell borders, and auto-sized columns. OpenClaw's own tools documentation lists no built-in Word/PowerPoint/Excel generation — this would need a plugin.
3. **First-class configured database connections** (SQLite/Postgres/MSSQL): schema introspection, mechanical row-level tools (list/count/find rows with no SQL needed), ad hoc SQL execution, and the ability to save a working query as its own reusable named tool for next time. Not a documented OpenClaw built-in.
4. **Generic REST/OpenAPI integration as a structured workflow**: introspect an OpenAPI/Swagger spec, call any endpoint with per-connection auth, auto-follow pagination, poll async jobs. OpenClaw's integrations are pre-built connectors to specific services, not a point-at-any-API system.
5. **Per-call, editable human-in-the-loop confirmation as the primary safety mechanism.** Every mutating tool call shows a dialog with the exact arguments (editable before approving), plus session-level and per-tool auto-approve rules. OpenClaw's default posture runs tools directly on the host with no per-call confirmation gate — safety comes from optional sandboxing and deterministic policy you configure yourself, which its own docs note is "off by default" for personal use.
6. **True local/free model support as an equal first-class option.** Ollama with no API key, selected the same way as any hosted provider, including live context-window detection read directly from the running Ollama server (correcting for Ollama's own default of loading a model at a much smaller runtime context than it's capable of). OpenClaw is model-agnostic too, but by embedding vendor agent harnesses (Claude Agent SDK, Codex, Copilot SDK) as plugins rather than talking to provider chat APIs directly.
7. **Workspace-boundary sandboxing enforced by real path canonicalization** (`WorkspaceGuard`) on every file tool, restricting all file operations to one configured folder regardless of what a tool is asked to touch.
8. **Visible process transparency**: live "which specialist is handling this" attribution in the transcript, a manual specialist-picker override, a real round-progress counter ("round 3/12"), and a context/cost meter grounded in the model's actual context window rather than a static guess.
9. **Local semantic search over your own past chat sessions** in this app, including the currently active one.

## What OpenClaw does that Sachivji does not

1. **Reaches you anywhere.** Native integrations with 20+ messaging channels (WhatsApp, Telegram, Discord, Slack, Microsoft Teams, Signal, iMessage, Google Chat, and more), plus native companion apps for macOS, iOS, Android, Windows, and Linux — including real mobile apps. Sachivji is an Electron desktop app only (macOS/Windows/Linux), with no mobile client and no messaging-platform presence.
2. **Runs as a persistent, always-on Gateway/daemon** that can act proactively/asynchronously (scheduled via built-in `cron`/heartbeat tools) even when you're not actively chatting — genuine ambient automation. Sachivji only acts while the app is open and you're actively sending messages.
3. **Device "nodes"**: camera, screen, voice, and other device-local capabilities as input/output surfaces on a phone or other connected device. Sachivji has no device-node concept.
4. **A public plugin ecosystem and marketplace (ClawHub)**: 100+ pre-built "AgentSkills" and 50+ third-party integrations (productivity tools, smart-home devices, music/audio platforms, automation tools) anyone can install or publish. Sachivji's extensibility is MCP server connections (a real, comparable protocol-level extension point, configured in Settings), but there's no public marketplace or community skill-sharing hub.
5. **Multi-user/team collaboration on one shared assistant deployment**: real-time presence, session ownership and participants, teammates observing, steering, or taking over a running session together. Sachivji is single-user/single-session, with no shared-deployment concept.
6. **Built-in generative media tools**: image, music, and video generation, plus text-to-speech. Sachivji has none of these.
7. **Embeds vendor coding-agent harnesses directly** (Claude Agent SDK, OpenAI's Codex harness, GitHub Copilot SDK) as plugins, inheriting each vendor's own native agentic-coding capabilities as they evolve. Sachivji implements its own orchestrator/tool-calling loop directly against each provider's plain chat-completions API.
8. **Much larger scale and backing**: an independent nonprofit foundation (501(c)(3)) with corporate sponsors, 390,000+ GitHub stars, and an active outside-contributor base — a far broader existing ecosystem of ready-made integrations than a single small app is likely to build alone.

## How to read this comparison

- OpenClaw's philosophy is "small core, large plugin ecosystem" — nearly every gap listed under it above (Excel writing, SQL access, etc.) could in principle be filled by installing or writing a plugin/skill. This comparison is about what ships **built-in and documented today**, not what's theoretically reachable through its plugin SDK.
- Sachivji's philosophy is close to the opposite: a fixed, curated, built-in tool set (no plugin marketplace beyond MCP), traded for tighter, more specific tool design (e.g., a mechanical `db_list_rows` instead of hand-written SQL) and an approval-first safety model for anything that mutates state.
- These are different products solving different problems: OpenClaw is a proactive, ambient, cross-device personal/life-automation assistant reachable through the channels you already use; Sachivji is a desktop, session-based, business/office-workflow assistant (documents, databases, APIs, spreadsheets) built around a curated multi-specialist orchestrator and an explicit human-approval safety model.

## Sources

- [OpenClaw GitHub repository](https://github.com/openclaw/openclaw)
- [OpenClaw docs — Why OpenClaw (architecture & security philosophy)](https://docs.openclaw.ai/start/why-openclaw)
- [OpenClaw docs — Tools](https://docs.openclaw.ai/tools)
- [OpenClaw — official site](https://openclaw.ai/)
- [What is OpenClaw? — DigitalOcean](https://www.digitalocean.com/resources/articles/what-is-openclaw)
