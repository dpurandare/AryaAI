# Sachivji — minimum LLM prompt size

Measured 2026-09-24, re-measured 2026-09-25 after gbrain and llmwiki were
removed from the app (only `energy_wiki` remains configured — confirmed
live via `app_settings.mcpServers` in `~/.config/Sachivji/sachiv.db`).
Directly against the real code: the real `SYSTEM_PROMPT` text
(`src/main/ipc/register.ts`, extracted verbatim), the real
`createDefaultRegistry()` + `createAgents()` output, and — unlike the
9/24 pass, which estimated MCP cost from an average — a **live-connected**
`energy_wiki` server via `McpManager.connectAll()` in a real vitest run
(electron mocked the same way `tools/setup.test.ts` does), giving real
schema text, not an estimate. Same tiktoken `o200k_base` estimator the app
itself uses for non-Anthropic/Google providers (`countTokensApprox` in
`src/main/providers/openai-compatible.ts`). This is the **bare** prompt —
fixed overhead only, no user question added.

## Fixed overhead — sent on every turn, before your question is added

| Component | Tokens |
|---|---|
| `SYSTEM_PROMPT` text alone | 926 |
| Orchestrator trailer wrapper (delegate-tool instructions, fixed text) | 67 |
| Specialist roster (5 agents, listed by role + summary) | 177 |
| **Full top-level system prompt** | **1,170** |
| Built-in tool schemas (43 tools) | 8,424 |
| Delegate-to-specialist tool schemas (8 tools) | 471 |
| **System prompt + built-in + delegate schemas (no MCP)** | **~10,065 tokens** |

## With the one remaining MCP server connected (energy_wiki, 8 tools)

Real, live-measured — not estimated:

| Server | Tools | Schema tokens |
|---|---|---|
| energy_wiki (llm-wiki-mcp) | 8 | 755 |

**Total bare overhead with energy_wiki connected: ~10,820 tokens**

## Before vs. after removing gbrain + llmwiki

| Configuration | Total bare overhead |
|---|---|
| Built-in + delegate tools only, no MCP | ~10,065 tokens |
| + energy_wiki only (current) | **~10,820 tokens** |
| + all 3 servers, 9/24 (gbrain 144 + energy_wiki 8 + llmwiki 14 = 166 MCP tools) | ~45,300 tokens (estimated) |

Removing gbrain and llmwiki cut the bare per-turn overhead by roughly
**76%** (~45,300 → ~10,820 tokens). gbrain's 144 tools were, by a wide
margin, the single biggest driver of prompt size — energy_wiki alone adds
only ~755 tokens (8 tools), a rounding error by comparison.

## Your question

A real 108-word sample query measured **~122 tokens** on 9/24 — under 2%
of the fixed overhead even in the current, much smaller configuration.

## Notes / caveats

- This is the **top-level orchestrator's first round** only. MCP tools are
  also attached to 5 of the specialist roles (`agents/roles.ts`'s
  `mcpTools(registry)` calls), so a request that gets delegated pays this
  same heavy tool-schema overhead again on that round, not just once per
  turn.
- Sachivji currently has **no lazy/deferred tool-loading mechanism** — every
  registered tool's full JSON schema (built-in and MCP) is sent on every
  round, always. There is no equivalent of "send the tool by name only,
  load its full schema on first use."
- Token counts use a tiktoken-based estimate calibrated for OpenAI-family
  models; the actual count for Anthropic/Google models (which have their
  own real `countTokens` API) would differ somewhat, though not by an
  order of magnitude.

## Comparison — Claude Code (this CLI)

Unlike the measurement above, this is **not** source-verified — Claude Code
isn't part of this repo and I have no file-system access to its
implementation. This is a rough, hand-estimated read of what's actually
observable in my own current session context, not a tokenizer-measured
figure.

What's actually present:
- A system prompt covering identity, task-handling conventions, tool-use
  guidance, tone/style, and a fairly substantial "memory" behavioral spec —
  on the order of several thousand words.
- ~12 **always-loaded** tools with full JSON schemas (Agent, Artifact, Bash,
  Edit, ListAgents, Read, ReportFindings, ScheduleWakeup, SendFeedback,
  Skill, ToolSearch, Write) — several fairly verbose.
- ~40 additional **deferred** tools (WebFetch, WebSearch, SendMessage, the
  MCP-connector tools, etc.) that appear as bare names only, with no
  schema loaded, until explicitly fetched via a dedicated lookup tool.

Rough estimate for the always-loaded portion: **~8,000–15,000 tokens**.
Deferred tools cost very little until actually used (just a name each).

**The structurally important difference from Sachivji**: Claude Code defers
loading a tool's full schema until it's actually needed, rather than
eagerly sending every available tool's complete definition every turn.
Sachivji currently has no equivalent — every registered tool (all 51 as
currently configured: 43 built-in + 8 delegate) gets its full schema sent
on every round, whether or not that turn touches it. With only energy_wiki
connected this costs relatively little (~755 tokens), but the lesson from
the 9/24 gbrain measurement stands: this eager-loading design means
overhead scales directly and uncapped with however many MCP tools get
connected, with no built-in ceiling.
