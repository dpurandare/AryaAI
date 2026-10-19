# Release triage: 0.3.2, 0.4.0 and 0.5.0

Started 2026-10-19. This document is where the open backlog (`TASKS.md`) is sorted into the next releases, one point at a time, and where every decision is recorded. `TASKS.md` stays the record of each item; this file is the plan.

## Inputs

- **Release 0.3.1 is stable.** It is installed and running well on the sponsor's Windows 11 AMD64 machine (since 2026-10-18), with Anthropic, OpenAI and Tavily keys. The sponsor will read the User Guide and explore the application before giving feedback. That feedback will add items to this plan.
- **Target for 0.4.0:** no fixed date; two weeks is the goal (Deepak, 2026-10-19).
- **Anthropic and Claude work is finished** (Deepak, 2026-10-19). Caching was verified on the real API on 2026-10-10, and items #120, #121 and #137 are closed. Extended thinking (#159) is not done in the code; Deepak asked on 2026-10-19 to keep it as a work item, proposed for 0.4.0.
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

## Proposed totals (before any further decision)

| Bucket | Items |
|---|---|
| 0.3.2 | 16 |
| 0.4.0 | 10 |
| 0.5.0 | 16 |
| Parked | 10 |
| Not this repo | 1 |
| Ongoing rule | 1 |
| **Total open items** | **54** |
| Closed during triage setup | 3 (#121, #137, #120) |

**Capacity warning.** 16 items in 0.3.2 (now including the L-sized #222) is a lot for a patch release, and 0.4.0 holds two L-sized features (#196 PDF reader and #160 video). We should expect to cut or move items as we decide.

## How we work

**Rule: this document is the source of truth. Nothing important lives only in the chat or in temporary files** (we have electricity interruptions, so anything not in the repo can be lost).

1. We go through the items in the order of the points below, one at a time.
2. **Before an item is presented in the chat, Claude writes its details and its bucket recommendation, with reasons, into the "Item details" section below, and commits and pushes it.**
3. **The moment Deepak decides, Claude writes the decision** into the decision log, the item's table row and its "Item details" entry, adds a one-line `Triage 2026-10-19: ...` note to the item in `TASKS.md`, updates its memory, and commits and pushes to `main`.
4. Open questions are kept in the "Pending questions" section, so they survive an interruption.
5. New items (for example from the sponsor's feedback) are added to the right point as they arrive.

## Points and status

The point names are only grouping labels I chose so related items are discussed together; they carry no extra meaning.

| Point | Items | Status |
|---|---|---|
| P1 Bundled Ollama | #214, #222 | decided (both 0.3.2, bundled Ollama only); follow-up questions pending |
| P2 Planner and loop reliability | #140, #141, #146, #170, #191, #192 | open |
| P3 Everyday UX and trust | #215, #218, #216, #193, #168, #194, #189, #190 | open |
| P4 Files and workspace | #204, #203, #169 | open |
| P5 Documents | #196, #183, #197, #198, #85 | open |
| P6 Provider quality: cost, thinking and evaluation | #159, #134, #122, #135, #136 | open |
| P7 Architecture | #124, #125, #127, #123, #205, #128, #132, #200, #49 | open |
| P8 Platform and distribution | #131, #208, #221, #220, #11, #63, #64, #65, #66 | open |
| P9 Integrations and media | #151, #160, #217, #76, #79, #195 | open |
| P10 Documentation | #92 | open |

## Decision log

| Date | Point | Items | Decision | Reason |
|---|---|---|---|---|
| 2026-10-19 | Setup | #121, #137, #120 | Closed | Deepak: all the Anthropic and Claude work that was planned is done. The stale 'blocked / carried forward' status was removed from TASKS.md, the triage and the manual-test report. |
| 2026-10-19 | P1 | #214 | 0.3.2; option (a) now, option (c) later (first decision, superseded below) | Deepak. |
| 2026-10-19 | P1 | #222 | Scope expanded: download models and run a Modelfile | Deepak: without this the bundled Ollama cannot be used. |
| 2026-10-19 | P1 | #214 | **Revised: use the bundled Ollama ONLY, for chat and for embeddings. No fallback to the user's own Ollama; option (c) dropped.** | Deepak: running two Ollama instances is not a good idea. |
| 2026-10-19 | P1 | #222 | **Bucket 0.3.2 (not 0.4.0)** | Deepak: a typical user with a good Windows machine or a MacBook with 24 GB or more of memory can run 9 to 20 billion parameter models (observed on his MacBook and Linux machine). Make the feature useful now; do not hold it to the end of 0.4.0. |
| 2026-10-19 | P6 | #159 | Kept as a work item; proposed 0.4.0 | Deepak: add Anthropic extended thinking wherever it fits. Not built yet, no Anthropic code for it; to be confirmed when P6 is discussed. |
| 2026-10-19 | P1 | #222 | Budget stated for GPU parts: about 100 MB more is acceptable | Deepak. Measured: Vulkan only +43 MB on disk; full CUDA +1.8 GB. Proposal is Vulkan only (pending confirmation, question 2). |

## Conflict raised and resolved (P1)

Option (a) as first described would have sent chat to the user's own Ollama and kept the bundled server for embeddings only, which conflicts with the requirement that the bundled Ollama be usable (download, Modelfile). **Resolved 2026-10-19 by Deepak: the app uses the bundled Ollama only, for both chat and embeddings.** There is no fallback to a user's own Ollama and no second instance.

## Pending questions (waiting for Deepak)

1. **P1, #214, port.** With the bundled Ollama as the only one, should it use a **dedicated port that is never 11434** (so it never collides with an Ollama the user runs for other tools)? Today it prefers 11434 and falls back to 11435 to 11438.
2. **P1, #222, GPU.** Deepak's budget (2026-10-19): an increase of **about 100 MB is acceptable**. Measured sizes below (Ollama v0.40.3, the pinned Windows archive; see "GPU backend sizes" under the #222 details). **Proposed: keep the Vulkan backend (+43 MB on disk, +13 MB in the download) and keep dropping CUDA (+1,743 MB on disk, +1,364 MB in the download), which is far over the budget.** Vulkan covers NVIDIA, AMD and Intel GPUs; it is slower than CUDA but much faster than CPU for models that fit in video memory. It must be tested before we rely on it (in the Ollama versions I know, Vulkan is opt-in through an environment variable and marked experimental; not verified for v0.40.3). Confirm?
3. **P1, #222, capacity and release shape.** #222 is an L-sized feature and now sits in 0.3.2, which was meant to be fix-only. Under the project's versioning a feature normally means a minor release. How do we keep it honest: (a) keep the name 0.3.2 and accept a bigger patch; (b) call it 0.4.0 and make the bundled-Ollama work the first release of that line, moving the other 0.3.2 fixes with it? Please decide, because it affects how we bucket everything else.
4. **P1, #222, minimum useful scope.** Is the scope in the item details (installed models list with delete, download with progress and cancel, a Modelfile editor with Create model, RAM and disk guidance) the right minimum, or should something be added or cut?

## Item details and recommendations

### #214: the "Ollama (local)" chat provider is redirected to the bundled Ollama (P1)

**Status: DECIDED 2026-10-19 (Deepak): bucket 0.3.2. REVISED decision: use the bundled Ollama ONLY, for chat and embeddings, no fallback to a user's own Ollama and no second instance; option (c) dropped. Open: the dedicated port (Pending question 1).**

**What it is.** The installers bundle a small Ollama server meant only for embeddings, which power search over past chats. When it starts, the app points every "Ollama" connection at it, including the "Ollama (local)" chat provider. The code is in `ipc/register.ts` (it calls `setBundledOllamaBaseUrl`) and `providers/setup.ts`.

**What goes wrong.**
1. **Chat on the wrong server.** The bundled server holds only `nomic-embed-text`, so a user with their own Ollama sees none of their installed models for chat.
2. **Port conflict.** The bundled server prefers port 11434 (Ollama's standard port) whenever it is free (`DEFAULT_PORT` in `runtime/ollama-runtime.ts`, with fallbacks 11435 to 11438). If a user starts their own Ollama after Sachivji is running, it cannot use that port. If their Ollama was already running, the bundled one moves to 11435, but chat is still redirected to it.

**Who is affected.** Anyone with their own Ollama: developers and local-model users. The sponsor is not affected, since he uses cloud models. Nobody can have been using the bundled server for chat, because it has no chat model and the app cannot download one yet (#222).

**Options.**

| Option | What it does | Effort |
|---|---|---|
| (a) | The bundled server gets its own port, never 11434, and is used **only for embeddings**. The "Ollama (local)" chat provider goes back to the user's own Ollama. | S-M |
| (b) | Leave it and keep the documented limitation. | None |
| (c) | A Settings field for the chat Ollama address, which would also allow an Ollama on another machine. | M |

**Recommendation (Claude): option (a), in 0.3.2.**
- It is a defect: chat is wired to a server that cannot chat, and it can block a user's own Ollama.
- It is contained. Chat and embeddings are already built in separate code paths (the registry for chat, `getEmbeddingProvider` for embeddings), so only the address each one uses changes. **No provider id is renamed**: a rename would flag the existing search index as needing a rebuild, which re-embeds everything.
- It does not affect the sponsor's chat, and embeddings keep the same bundled server and model, so his index stays valid.

**Risks.** The first-run model download goes through the bundled server, so first run must be re-tested on a clean machine. A user who picks "ollama" as the embedding provider with a model that exists only on their own Ollama would still be sent to the bundled server; this limit must be documented.

**Option (c) later.** A shared Ollama server on a LAN is a realistic enterprise setup. Pair it with #222.

**Conflict raised after the decision (2026-10-19).** Option (a) sends chat to the user's own Ollama and keeps the bundled server for embeddings only. Deepak's new requirement (see #222) is that the bundled Ollama must be usable, with model download and Modelfile changes. A user with no Ollama of their own and a model downloaded into the bundled server would then be unable to chat with it. **Proposed resolution (not yet confirmed):** the "Ollama (local)" chat provider uses the user's own Ollama when one answers on port 11434, and otherwise falls back to the bundled server on its dedicated port. No new setting, no provider rename, and the search index stays valid.

**Revised decision (2026-10-19, Deepak).** Use the bundled Ollama only. Running two Ollama instances is not a good idea, so there is no fallback to the user's own Ollama and option (c) is dropped. What remains of this item: (1) keep chat and embeddings both on the bundled server (today's routing becomes the intended design, not a defect); (2) stop the bundled server from contending for port 11434, using a dedicated port (to confirm, Pending question 1); (3) fix the stale comments and messages that say the bundled Ollama exists only in the Windows sponsor build; (4) tell users plainly in the User Guide that Sachivji uses its own Ollama, so models installed in another Ollama are not visible and are downloaded again through #222.

**To record in the code work (0.3.2):** a dedicated port for the bundled server away from 11434; chat and embeddings use separate addresses; fix the stale comments and messages that say the bundled Ollama exists only in the Windows sponsor build (`ipc/register.ts`, `ollama-runtime.ts`); update User Guide page 03 (known limitation) and Developer Guide pages 05 and 08; re-test first run on a clean machine.

### #222: download models and run a Modelfile on the bundled Ollama (P1)

**Status: DECIDED 2026-10-19 (Deepak): bucket 0.3.2, size L. Open: GPU, release shape and minimum scope (Pending questions 2 to 4).**

**What it is.** The bundled server is CPU-only and holds only the embedding model. The code to pull a model exists (`OllamaRuntime.pullModel`) but is used only for the embedding model. A user cannot get a chat model, change a model's parameters, or list or delete models.

**Deepak's requirement (2026-10-19).** The user must be able to **download models** and **run a Modelfile to change model parameters**. "Without which using bundled Ollama will not be possible."

**Proposed scope: Settings > Local models.**
- Status of the bundled server and where its models are stored.
- Installed models: name, size, context window, and **Delete**.
- **Download:** type a model name or pick from a short suggested list, with progress and **Cancel**. Warn about size and free disk space, and say plainly that a CPU-only server is slow.
- **Modelfile:** an editor with a template, plus "Create model", which uses Ollama's create API under a name the user chooses. This is how a user raises `num_ctx`, `temperature` and so on.
- The app already reads a model's configured `num_ctx` for its context meter (`configuredContextWindow`), so changed parameters will show there.

**Recommendation (Claude): bucket 0.4.0, size L.** Moved up from 0.5.0 because the bundled Ollama is not usable without it. **Capacity catch:** 0.4.0 already holds the PDF reader (L) and video (L); three L-sized features do not fit in two weeks. We decide the final cut once every item is bucketed.

**Risks.** Models are large (hundreds of MB to many GB), so disk space and failed or cancelled downloads need care. CPU-only speed makes most useful models feel slow, so the UI must say so. A free-text model name needs validation.

**GPU backend sizes (measured 2026-10-19 from the pinned Ollama v0.40.3 Windows archive, `ollama-windows-amd64.zip`, 1,400 MB download, 1,852 MB unpacked, by reading the zip directory).**

| Part | Unpacked | In the download | Shipped today? |
|---|---|---|---|
| Everything we ship now (CPU libraries, `ollama.exe`) | about 66 MB | about 23 MB | yes |
| `lib/ollama/vulkan` | **43 MB** | **13 MB** | no (excluded) |
| `lib/ollama/cuda_v13` | 634 MB | 495 MB | no (excluded) |
| `lib/ollama/cuda_v12` | 1,109 MB | 869 MB | no (excluded) |

- **Keeping everything GPU-related** (CUDA 12 and 13 plus Vulkan) adds about **1.8 GB on disk and 1.4 GB to the installer**. That is not 100 MB.
- **Keeping only Vulkan** adds about **43 MB on disk and 13 MB to the installer**, inside the 100 MB budget.
- On **Linux** the fetch script excludes only the CUDA folders, so Vulkan is probably already in the shipped 103 MB bundle (not checked); CUDA there is also about 1.3 GB or more. On **macOS** Metal is already in the 480 MB bundle.
- AMD's ROCm build is a separate Ollama download (243 MB on Windows, 1,003 MB on Linux), not part of these archives; it is not proposed.
- The Windows installer is also published as a `.zip` on GitHub, and a single release file has a 2 GB limit; adding CUDA would push it close to that limit.

**Decision (2026-10-19, Deepak): bucket 0.3.2.** Reason given: a typical user with a good Windows machine or a MacBook with 24 GB or more of memory can run 9 to 20 billion parameter models (he observed this on his MacBook and his Linux machine), so the bundled Ollama is useful once model download and Modelfile changes exist; splitting the feature and shipping it at the end of 0.4.0 would leave it unavailable. **Consequences to settle** (Pending questions 2 to 4): the Windows and Linux bundles are CPU-only; this puts an L-sized feature in a release meant to be fix-only; and the minimum scope must be agreed.

**Depends on.** #214 (bundled Ollama only). The chat provider and embeddings both use the bundled server, so a downloaded model is immediately usable for chat.

## Closed during triage setup

| # | Item | Why closed |
|---|---|---|
| #121 | Anthropic caching: real-API check, cost model, 11b.7 | Closed 2026-10-19 by Deepak: all planned Anthropic work is done. |
| #137 | Everything needing an Anthropic key | Closed 2026-10-19 by Deepak: all planned Anthropic and Claude work is done. |
| #120 | Multi-model routing evaluation and replay probe | Closed 2026-10-19 by Deepak: the formal Claude evaluation was skipped on 2026-10-10 and the planned work is done. |

## P1 Bundled Ollama

| # | Item | Type | Proposed | Size | Why | Decision |
|---|---|---|---|---|---|---|
| #214 | Chat provider 'Ollama (local)' is routed to the bundled embedding-only Ollama in packaged builds | defect + decision | 0.3.2 | S-M | Revised 2026-10-19: the bundled Ollama is used for chat and embeddings; remaining work is the port, stale messages and docs. | **Decided 2026-10-19 (Deepak): 0.3.2; use the bundled Ollama only (chat and embeddings); option (c) dropped.** Open: the dedicated port. |
| #222 | Download other models when only the bundled Ollama exists (model download UI) | feature | 0.3.2 | L | Decided 2026-10-19: 9 to 20B models run well on a 24 GB or larger Windows machine or MacBook, so make the bundled Ollama useful now. | **Decided 2026-10-19 (Deepak): 0.3.2; scope = download models and run a Modelfile.** Open: GPU, release shape, minimum scope. |

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
| #159 | Anthropic extended thinking support | feature | 0.4.0 | M | Added as a work item by Deepak 2026-10-19. The code has no extended-thinking support; the sponsor uses Anthropic and the key is available, so it can be verified live. | open |
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
