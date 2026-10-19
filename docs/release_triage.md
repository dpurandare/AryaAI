# Release triage: 0.3.2, 0.4.0 and 0.5.0

Started 2026-10-19. This document is where the open backlog (`TASKS.md`) is sorted into the next releases, one point at a time, and where every decision is recorded. `TASKS.md` stays the record of each item; this file is the plan.

## Inputs

- **Release 0.3.1 is stable.** It is installed and running well on the sponsor's Windows 11 AMD64 machine (since 2026-10-18), with Anthropic, OpenAI and Tavily keys. The sponsor will read the User Guide and explore the application before giving feedback. That feedback will add items to this plan.
- **Target for 0.4.0:** no fixed date; two weeks is the goal (Deepak, 2026-10-19).
- **Anthropic key:** configured on this machine and on the sponsor's. Anthropic prompt caching was verified on the real API on 2026-10-10 (the docs were corrected on 2026-10-19).
- **Who uses it:** the sponsor is the main user and uses cloud models. That lowers the priority of items found only on local models, and raises the priority of cloud-model quality and the Windows experience.

## Buckets

| Bucket | Meaning |
|---|---|
| **0.3.2** | Defects and small enhancements. Fix-only, low risk, on the 0.3.x line. Should be about one week of work. |
| **0.4.0** | Features to build and ship, about two weeks. |
| **0.5.0 (detail)** | Features we will **design and detail** now (decisions, design notes, engine choices) but not build until 0.5.0. |
| **Parked** | Deliberately not planned. Kept in `TASKS.md` with a reason. |
| **Not this repo / Ongoing rule** | Belongs elsewhere, or is a standing rule and not a task. |

**Sizes** are my rough estimates, not measurements: **S** is a day or less, **M** is two to four days, **L** is a week or more.

## Proposed totals (before any decision)

| Bucket | Items |
|---|---|
| 0.3.2 | 16 |
| 0.4.0 | 12 |
| 0.5.0 | 17 |
| Parked | 10 |
| Not this repo | 1 |
| Ongoing rule | 1 |
| **Total open items** | **57** |

**Capacity warning.** 16 items in 0.3.2 is a lot for a patch release, and 0.4.0 holds two L-sized features (#196 PDF reader and #160 video). We should expect to cut or move items as we decide.

## How we work

1. We go through the points below in order, one item at a time. For each item we decide its bucket, or defer it, or change its scope.
2. **After every point**, Claude records the decisions in the log below and in the tables, adds a one-line `Triage 2026-10-19: ...` note to the item in `TASKS.md`, updates its memory, and commits and pushes to `main`. Work is saved at every step because of the electricity problems.
3. New items (for example from the sponsor's feedback) are added to the right point as they arrive.

## Points and status

The point names are only grouping labels I chose so related items are discussed together; they carry no extra meaning.

| Point | Items | Status |
|---|---|---|
| P1 Bundled Ollama | #214, #222 | open |
| P2 Planner and loop reliability | #140, #141, #146, #170, #191, #192 | open |
| P3 Everyday UX and trust | #215, #218, #216, #193, #168, #194, #189, #190 | open |
| P4 Files and workspace | #204, #203, #169 | open |
| P5 Documents | #196, #183, #197, #198, #85 | open |
| P6 Provider quality: cost, thinking and evaluation | #121, #137, #120, #159, #134, #122, #135, #136 | open |
| P7 Architecture | #124, #125, #127, #123, #205, #128, #132, #200, #49 | open |
| P8 Platform and distribution | #131, #208, #221, #220, #11, #63, #64, #65, #66 | open |
| P9 Integrations and media | #151, #160, #217, #76, #79, #195 | open |
| P10 Documentation | #92 | open |

## Decision log

*(Nothing decided yet. Each entry: date, point, item, decision, reason.)*

## P1 Bundled Ollama

| # | Item | Type | Proposed | Size | Why | Decision |
|---|---|---|---|---|---|---|
| #214 | Chat provider 'Ollama (local)' is routed to the bundled embedding-only Ollama in packaged builds | defect + decision | 0.3.2 | S-M | Needs your decision first. Smallest fix: the bundled server serves embeddings only; the chat provider talks to the user's own Ollama. | open |
| #222 | Download other models when only the bundled Ollama exists (model download UI) | feature | 0.5.0 (detail) | L | Depends on #214. Local-first matters, but the sponsor uses cloud models. | open |

## P2 Planner and loop reliability

| # | Item | Type | Proposed | Size | Why | Decision |
|---|---|---|---|---|---|---|
| #140 | Record why a planning reply was empty (stop reason, token count) | chore (diagnostic) | 0.3.2 | S | Small, and it tells us whether #141 needs more than a retry. | open |
| #141 | Retry the planning call once when its reply is empty | defect | 0.3.2 | S | Compound requests silently lose their split today. | open |
| #146 | MCP-availability substitution for the single-step delegate path | defect | 0.3.2 | M | Same failure shape as #145, which only covered multi-step plans. | open |
| #170 | Keep a compact summary (not a content-free marker) in collapseOldestToolResultsToFit | defect | 0.3.2 | S | Same flaw #149 already fixed in a sibling function. | open |
| #191 | Reasoning-loop breaker for local models | enhancement | 0.4.0 | M | Found on a local model; matters less for cloud users, so not a patch. | open |
| #192 | Keep each plan step to its own job | enhancement | 0.4.0 | M | Analysis item; fixes the cause behind #191. | open |

## P3 Everyday UX and trust

| # | Item | Type | Proposed | Size | Why | Decision |
|---|---|---|---|---|---|---|
| #215 | Pinned specialist does not state its role when greeted | defect | 0.3.2 | S | Manual test 11.6 expects it; probed on gpt-4o-mini, all 12 roles fail. | open |
| #218 | Check Settings > Auto-approve rules (why mcp_llmwiki appears; rules for MCP, databases, APIs) | defect (investigate) | 0.3.2 | S-M | Quick look says the list is generated from the live registry; needs the full check. | open |
| #216 | Grant outside-folder access up front in Settings (Add folder...) | enhancement | 0.3.2 | S | Small, and removes a repeated confirmation. | open |
| #193 | Agent picker opens a menu instead of cycling | enhancement | 0.3.2 | S | Small UI change, clear request. | open |
| #168 | Ollama Cloud usage shown as $0 | defect | 0.3.2 | S-M | Wrong number shown to the user; needs a small UI prop chain. | open |
| #194 | Group the session list by date (configurable) | enhancement | 0.4.0 | M | Nice to have; not urgent. | open |
| #189 | Search across past conversations (find a session by text) | feature | 0.4.0 | M-L | Related to #190; shared matching code. The memory index already exists. | open |
| #190 | Find within the current session (Ctrl/Cmd+F) | feature | 0.4.0 | M | Do with #189. | open |

## P4 Files and workspace

| # | Item | Type | Proposed | Size | Why | Decision |
|---|---|---|---|---|---|---|
| #204 | Files landing in the workspace root (122 stray PNGs from scripts) | defect | 0.3.2 | M | Analysis done, fix not started; a visible mess for every user. | open |
| #203 | Design a workspace cleanup mechanism | design | 0.5.0 (detail) | M | Design only; #204 stops the worst source first. | open |
| #169 | grep / find_in_files content search tool | feature | 0.4.0 | M | Small tool; budget-tested; split from #148. | open |

## P5 Documents

| # | Item | Type | Proposed | Size | Why | Decision |
|---|---|---|---|---|---|---|
| #196 | PDF reader (convert once, read in sections) | feature | 0.4.0 | L | Repeated user request; the engine choice must be decided first. | open |
| #183 | Read text from images and scanned documents (OCR) | feature | 0.5.0 (detail) | L | Needs an engine decision (bundle vs optional); large binary impact. | open |
| #197 | Build a deck from the user's own PowerPoint template | feature | 0.5.0 (detail) | L | Engine choice to confirm; family with #198 and #85. | open |
| #198 | Template generation from an existing document, done properly | feature (research) | 0.5.0 (detail) | L | Research first, then design. | open |
| #85 | Template selection during document creation | feature | 0.5.0 (detail) | M | Depends on #198 and a default-template setting. | open |

## P6 Provider quality: cost, thinking and evaluation

| # | Item | Type | Proposed | Size | Why | Decision |
|---|---|---|---|---|---|---|
| #121 | Cost model for cached input; 11b.7 caching switch test | enhancement | 0.3.2 | S | The real-API check is already done; the cost shown is an upper bound. | open |
| #137 | Everything needing an Anthropic key: Claude routing eval, Appendix E rows | chore (evaluation) | 0.4.0 | M | Unblocked; the sponsor uses Anthropic and OpenAI, so measure them. **Note: Deepak skipped the formal Claude routing evaluation on 2026-10-10 (Anthropic already ran well in real use); this proposal goes against that and may be dropped.** | open |
| #120 | Multi-model routing evaluation and replay probe with real keys | chore (evaluation) | 0.4.0 | M | Same run as #137; Anthropic and OpenAI are the priority. **Same note as #137: skipped by Deepak on 2026-10-10; may be dropped.** | open |
| #159 | Anthropic extended thinking support | feature | 0.4.0 | M | Unblocked; verify the live request shape first. | open |
| #134 | Declare vite-node as a pinned devDependency | chore | 0.3.2 | S | The eval scripts depend on whatever npx downloads today. | open |
| #122 | Slim router hot-core review (drop read_file, list_directory?) | enhancement | Parked | S | The slim router is experimental and off by default; revisit with #123-#127. | open |
| #135 | Slim/full router on provider tiers with hard limits (Groq, Mistral findings) | enhancement | Parked | M | Groq-specific; the sponsor does not use Groq. | open |
| #136 | Finish the Groq evaluation after the daily limit resets | chore (evaluation) | Parked | S | Depends on Groq quota; low value now. | open |

## P7 Architecture

| # | Item | Type | Proposed | Size | Why | Decision |
|---|---|---|---|---|---|---|
| #124 | Nested delegation (a specialist can delegate; move the deck flow under Document Creator) | feature (architecture) | 0.5.0 (detail) | L | Large; needs real-model evaluation. | open |
| #125 | Context scoping per hop; root cause of #105 | design | 0.5.0 (detail) | L | Changes what each role sees; design first. | open |
| #127 | Router SYSTEM_PROMPT diet (about 860 to about 350 tokens) | enhancement | 0.5.0 (detail) | M | Blocked on #124. | open |
| #123 | MCP Operator lazy schema loading and per-server toggles | feature (architecture) | 0.5.0 (detail) | M-L | Same topic as #205; one design for both. | open |
| #205 | Design revisit: MCP tool schemas are not lazily loaded | design | 0.5.0 (detail) | M | Merge into #123. | open |
| #128 | Skills (agentskills.io style) for roles | feature (architecture) | 0.5.0 (detail) | L | Advice already given: stage it; prove value with plain role files first. | open |
| #132 | User-defined roles follow-ups (role_create tool, eval, sharing) | feature | 0.5.0 (detail) | M-L | Group with #200 and #128. | open |
| #200 | Expand user-defined roles and how they are used | feature | 0.5.0 (detail) | L | Scope still to design; group with #132 and #128. | open |
| #49 | Rolling summarization of earlier turns | feature | 0.5.0 (detail) | L | Needs its own trigger-policy design; search_history covers part of the need. | open |

## P8 Platform and distribution

| # | Item | Type | Proposed | Size | Why | Decision |
|---|---|---|---|---|---|---|
| #131 | Runtime hardening: venv-creation lock, single-instance lock, .deb check, large-workspace cap | defect + chores | 0.3.2 (locks only) | M | Split: the two locks fix a real race; the rest is parked. | open |
| #208 | Verify the macOS self-contained build (Ollama Metal) on real Apple Silicon | verification | 0.3.2 | S | Your Mac can run it; it has never been executed. | open |
| #221 | Tests for aws / az / gcloud basic operations | chore (tests) | 0.3.2 | S | Mocked tests only; no cloud calls. | open |
| #220 | sudo support for shell_execute (design with the interactive terminal, #210) | feature | 0.5.0 (detail) | L | A pty terminal makes password entry safe by construction; design them together. | open |
| #11 | Code signing and notarization in CI | chore (business) | Parked | - | Decided 2026-10-14: deferred until wider distribution. | open |
| #63 | Apple Developer Program enrolment and certificate | chore (business) | Parked | - | Deferred with #11. | open |
| #64 | Apple notarization credentials as CI secrets | chore (business) | Parked | - | Deferred with #11. | open |
| #65 | Windows Authenticode certificate | chore (business) | Parked | - | Deferred with #11. | open |
| #66 | Wire signing into electron-builder and release.yml | chore (business) | Parked | - | Deferred with #11. | open |

## P9 Integrations and media

| # | Item | Type | Proposed | Size | Why | Decision |
|---|---|---|---|---|---|---|
| #151 | Verify and scope video support | verification | 0.4.0 | S | Prerequisite for #160. | open |
| #160 | Real video support in the workspace | feature | 0.4.0 (already committed) | L | You committed this to 0.4.0 on 2026-10-13; #151's verification comes first. | open |
| #217 | External APIs needing a key plus a session token; self-configuring set-up | feature | 0.5.0 (detail) | L | Large design (login, token, expiry, re-login). | open |
| #76 | More database engines (Oracle remains; SQL Server and MySQL are done) | feature | Parked | - | Close the finished part; Oracle only on demand. | open |
| #79 | Email phase 2: Outlook / Microsoft Graph (Gmail is done) | feature | Parked | - | Needs OAuth sign-in; do with #217's authentication work if ever. | open |
| #195 | LLM wiki search fails on hyphenated numbers | defect (other project) | Not this repo | - | The bug is in the separate llmwiki project; track it there. | open |

## P10 Documentation

| # | Item | Type | Proposed | Size | Why | Decision |
|---|---|---|---|---|---|---|
| #92 | Reference documentation (User Guide and Developer Guide) | ongoing | Ongoing rule | - | Both guides are written and reviewed. Replace the open item with a per-release rule: update both guides and regenerate the PDFs. | open |
