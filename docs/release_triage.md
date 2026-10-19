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
| 0.3.2 | 15 |
| 0.4.0 | 11 |
| 0.5.0 | 17 |
| Parked | 10 |
| Not this repo | 1 |
| Ongoing rule | 1 |
| **Total open items** | **55** |
| Closed during triage setup | 5 (#121, #137, #120, #222, #223) |

**Capacity warning.** 15 items in 0.3.2 is a lot for a patch release, and 0.4.0 holds two L-sized features (#196 PDF reader and #160 video). We should expect to cut or move items as we decide.

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
| P1 Bundled Ollama | #214, #224, #225 (#222 and #223 closed) | decided; four small confirmations pending |
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
| 2026-10-19 | P1 | #222 | **GPU: keep the Vulkan backend only (+43 MB on disk, +13 MB download); keep dropping CUDA** | Deepak: "I am ok with your proposal for now (for 0.3.2)". |
| 2026-10-19 | P1 | #214 | **The bundled Ollama uses a non-standard port, never 11434; range 11450 to 11455, first free one** | Deepak: use a port that is not the standard Ollama port; the range comes from his 0.5.0 spec and is applied to 0.3.2 for consistency. Replaces today's 11434 then 11435 to 11438. |
| 2026-10-19 | P1 | #223 (new) | **Added as a 0.5.0 TODO** | Deepak's spec for detecting an existing Ollama (recorded in the item details). Claude's assessment is recorded there too; Deepak has not yet decided on it. |
| 2026-10-19 | P1 | #223 | Detect an existing Ollama **inside the app**, not in the installer | Deepak: OK (Claude's recommendation 1). |
| 2026-10-19 | P1 | #223 | **Embeddings may use whichever Ollama is in use; the bundled one is a fallback only. No point running two Ollama servers (memory load).** | Deepak: "the embeddings are in SQLite so it does not matter which server creates those." Claude's note, recorded as a design aspect: the stored vectors are in SQLite, but each search query is turned into a vector by the live server, and it must be the same model weights as the one that built the index; guard it by storing the model digest with the index. |
| 2026-10-19 | P1 | #223 | Never switch silently: tell the user clearly and handle the needed settings | Deepak: OK (recommendation 3). |
| 2026-10-19 | P1 | #223 | A setting that says which server the app uses, and on-demand start of the bundled server, are **a detailed design aspect** | Deepak (recommendation 4). Listed under "Detailed design aspects" in the #223 details. |
| 2026-10-19 | P1 | #223 | When the existing Ollama goes away: **embeddings fall back to the bundled Ollama; for chat, a configurable default fallback model, which may be a cloud model** | Deepak (answer to question 1). |
| 2026-10-19 | P1 | #222 | **Moved to 0.4.0, entire** (download models and Modelfile management) | Deepak: moving it entirely to 0.4.0 makes sense. |
| 2026-10-19 | P1 | #214 | **In 0.3.2 the bundled Ollama is a fallback only and provides only embeddings** (Claude's reading of Deepak's "as we decided now"; TO CONFIRM). This returns #214 to its option (a): chat is not routed to the bundled server, which keeps the port range 11450 to 11455. | Deepak: "embedded Ollama is a fallback only and will provide only embedding now." Supersedes the earlier "bundled Ollama only for chat and embeddings" revision. |
| 2026-10-19 | P1 | #222 | The Vulkan decision (+43 MB) is **not needed in 0.3.2** (embeddings only, CPU is enough); it is carried to 0.4.0 for when chat runs on the bundled server | Claude's consequence of the two decisions above (TO CONFIRM). |
| 2026-10-19 | P1 | #214 | **"Ollama (local)" is hidden from the model selection when the local Ollama is not available** | Deepak. It builds on the proposed hard decision (embedded Ollama for embeddings only; chat on the user's own Ollama), which still awaits his explicit confirmation. |
| 2026-10-19 | P1 | #214, #222, #223 | **THE HARD DECISION: the embedded Ollama is used ONLY for embeddings, always, with `nomic-embed-text`; chat uses the user's own local Ollama when available (or a cloud provider). #222 and #223 are closed.** | Deepak proposed it; he answered "Ok" to Claude's agreement and consequences, which Claude records as confirmation (correct this entry if that was not meant). |
| 2026-10-19 | P1 | #214 | **The embedded Ollama must still NOT use the default Ollama port (11434)**; range 11450 to 11455, first free | Deepak, restating the port decision. |
| 2026-10-19 | P1 | #214 | **When "Ollama (local)" is not available, Settings shows the Ollama address and/or instructions to install Ollama** (the entry itself stays out of the model selection) | Deepak. This accepts Claude's hint idea and goes further. |
| 2026-10-19 | P1 | #224, #225 (new) | Created from the remaining optional ideas: the embedding digest guard (#224, proposed 0.4.0) and the default fallback chat model (#225, proposed 0.5.0) | Claude, to confirm; buckets pending. |

## Conflict raised and resolved (P1)

Option (a) as first described would have sent chat to the user's own Ollama and kept the bundled server for embeddings only, which conflicts with the requirement that the bundled Ollama be usable (download, Modelfile). **Resolved 2026-10-19 by Deepak, then changed the same day:** first the app was to use the bundled Ollama only, for chat and embeddings; later Deepak decided the bundled Ollama is a fallback that provides only embeddings, and the whole bundled-chat feature (#222) moves to 0.4.0. See the decision log.

## Pending questions (waiting for Deepak)

*(The hard decision itself is recorded as confirmed, see the decision log. These are the small remaining confirmations for P1.)*

1. **Hidden-at-start-up case (#214).** If the saved active provider is "ollama" and the local Ollama is not reachable when the app starts, do not switch silently: keep the choice visible as "Ollama (local), not running" and give a clear error when a message is sent. Right?
2. **Is the Ollama address editable in Settings (#214)?** Deepak said Settings should show the address (and/or instructions) when Ollama is not available. Claude proposes showing the address in an **editable field**, default `127.0.0.1:11434` (this also allows an Ollama on another machine, such as a shared GPU server), plus the install instructions and the link ollama.com/download. Editable, or display only?
3. **#224, embedding digest guard.** Store the embedding model's digest with the index and show "needs rebuild" if the server reports a different one; pin the model by digest if Ollama can. Proposed size S, bucket 0.4.0 (it is in the same area as #214, so 0.3.2 is possible). Which bucket?
4. **#225, default fallback chat model.** A configurable fallback (possibly a cloud model) used when the chosen local Ollama is unavailable; an explicit, visible choice. Proposed size M, bucket 0.5.0 (detail), together with the automatic model selection document. Agree, or drop it?
5. **Bundled server start-up (#214).** Keep it starting at launch as today, only on the new port (simple). Starting it only when an embedding is needed would save idle memory and can come later. Agree?

## Item details and recommendations

### #214: the "Ollama (local)" chat provider is redirected to the bundled Ollama (P1)

**Status: FINAL SCOPE DECIDED 2026-10-19 (Deepak): bucket 0.3.2. The embedded Ollama serves ONLY embeddings, always, with `nomic-embed-text`, on a non-standard port (range 11450 to 11455, first free, never 11434). The "Ollama (local)" chat provider uses the user's own Ollama and is hidden from the model selection when that is not available; Settings then shows the Ollama address and/or install instructions.**

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

**History: first revision (2026-10-19, Deepak), superseded by the second revision above.** Use the bundled Ollama only. Running two Ollama instances is not a good idea, so there is no fallback to the user's own Ollama and option (c) is dropped. What remains of this item: (1) keep chat and embeddings both on the bundled server (today's routing becomes the intended design, not a defect); (2) stop the bundled server from contending for port 11434, using a dedicated port (to confirm, Pending question 1); (3) fix the stale comments and messages that say the bundled Ollama exists only in the Windows sponsor build; (4) tell users plainly in the User Guide that Sachivji uses its own Ollama, so models installed in another Ollama are not visible and are downloaded again through #222.

**Final scope: what the 0.3.2 code work is.** (1) The bundled server serves **embeddings only** and uses a port in 11450 to 11455 (first free, never 11434), so it can never take the standard port; (2) the registry's "Ollama (local)" chat provider stops being redirected to it and uses the user's own Ollama at the default address; `getEmbeddingProvider('ollama')` keeps using the bundled server, so no provider id is renamed and the existing search index stays valid; (3) fix the stale comments and messages; (4) update the guides: Sachivji does not offer local chat models through its bundled Ollama in this release, and a user who wants local chat installs Ollama themselves; (5) re-test first run on a clean machine.

**Added to the code work on 2026-10-19:** hide "Ollama (local)" from the model selection when unavailable (reachability check with a short timeout, cached briefly, re-checked when Settings opens or the provider list refreshes); in Settings show the Ollama address (editable, to confirm) and install instructions when it is not available; the guides say plainly that Sachivji's bundled Ollama only does embeddings and that local chat needs the user's own Ollama.

**To record in the code work (0.3.2), original list:** a dedicated port for the bundled server away from 11434; chat and embeddings use separate addresses; fix the stale comments and messages that say the bundled Ollama exists only in the Windows sponsor build (`ipc/register.ts`, `ollama-runtime.ts`); update User Guide page 03 (known limitation) and Developer Guide pages 05 and 08; re-test first run on a clean machine.

### #222: download models and run a Modelfile on the bundled Ollama (P1)

**Status: CLOSED, NOT NEEDED (2026-10-19), by the hard decision: the embedded Ollama only does embeddings, so Sachivji does not download models or run Modelfiles; users manage models with their own Ollama. The text below is kept as history.**

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

**Earlier decision the same day (superseded: moved to 0.4.0): bucket 0.3.2.** Reason given: a typical user with a good Windows machine or a MacBook with 24 GB or more of memory can run 9 to 20 billion parameter models (he observed this on his MacBook and his Linux machine), so the bundled Ollama is useful once model download and Modelfile changes exist; splitting the feature and shipping it at the end of 0.4.0 would leave it unavailable. **Consequences to settle** (Pending questions 2 to 4): the Windows and Linux bundles are CPU-only; this puts an L-sized feature in a release meant to be fix-only; and the minimum scope must be agreed.

**Depends on.** #214 (bundled Ollama only). The chat provider and embeddings both use the bundled server, so a downloaded model is immediately usable for chat.

### #223: detect an existing Ollama; keep the bundled Ollama always present on its own port (P1, new, 0.5.0)

**Status: CLOSED, DISSOLVED (2026-10-19), by the hard decision. What survives: the status and instructions in Settings and hiding "Ollama (local)" (now part of #214), the embedding digest guard (#224) and the fallback chat model (#225). The text below is kept as history.**

**Deepak's spec (2026-10-19), recorded as given.**
1. The installer bundles the Ollama defined for 0.3.2 (CPU libraries plus Vulkan, model download and Modelfile management, port 11450 to 11455).
2. The installer checks whether a local Ollama is installed. If yes, it asks that Ollama to download the embedding model, and sets Settings so the already installed Ollama is used.
3. Irrespective of whether an Ollama is installed, the bundled Ollama is installed and is available on a separate port, between 11450 and 11455 depending on availability.
4. If the user turns off or uninstalls the existing Ollama, the bundled Ollama should work only for the embedding operations.

**Claude's assessment (2026-10-19): a good scheme, with four changes.**

*Why it is good.*
- It solves the GPU gap properly. Users with their own Ollama keep CUDA or ROCm speed and the models they already downloaded, while everyone else gets a working local setup out of the box. Vulkan only (decided for 0.3.2) is a stopgap; an existing Ollama is the real answer for GPU owners.
- A separate non-standard port means the two servers never collide, and the existing Ollama is never touched or restarted by Sachivji.
- It avoids downloading the same multi-gigabyte models twice, since chat uses the models the user already has.

*Changes I recommend.*
1. **Do the detection inside the app, not in the installer.** Only the Windows installer has any install-time logic; the macOS disk image, the Linux AppImage and the `.deb` have none. An installer also cannot reliably write the per-user Settings database (it may run elevated, for all users), and downloading a model during installation is slow and fragile. The app already has first-run screens (Python, embeddings); add a step "We found Ollama on this computer. Use it for chat? (Use it / Use the bundled one)", and a Settings choice so the user can change it later. This works the same on all three systems.
2. **Keep embeddings always on the bundled server; do not ask the existing Ollama to download the embedding model.** The search index records only the provider and model name. If embeddings came sometimes from the existing Ollama and sometimes from the bundled one, a different tag or version of `nomic-embed-text` could produce slightly different vectors and silently damage search results. One fixed, pinned source avoids that, and it also means we never change the user's Ollama installation.
3. **Never switch silently.** Detect the existing Ollama (a quick request to its address) at start-up and when Settings opens, and show its status. If it disappears while chat was using it, say so and offer the bundled one with one click. Deepak's spec says the bundled one then works only for embeddings; I would offer chat on it as an explicit choice, because 0.3.2 already gives it model management. This is Pending question 3(c).
4. **Start the bundled server on demand** (first embedding or chat request) instead of at every launch, so two servers are not both resident. Models unload when idle, so the cost of an idle server is small, but on demand is cleaner. Also bind both to the loopback address only.

*Costs and risks.*
- The test matrix grows: an existing Ollama present or absent, running or stopped, different versions, on three operating systems. It needs written manual test cases.
- The Windows port range 11450 to 11455 should be checked against ranges Windows reserves for itself; the first-free fallback already handles a clash.
- Two Ollama processes can run at once when the existing one is in use for chat (the bundled one idles). This relaxes Deepak's earlier remark that two instances are not a good idea; it is acceptable only because they have separate jobs.

*Size and bucket.* L, as proposed: 0.5.0 (detail). The design must be settled with the 0.3.2 work in mind, so 0.3.2 should already keep chat and embeddings as separate code paths with a configurable address, which makes #223 an extension and not a rewrite.

**Deepak's reactions to the assessment (2026-10-19).** (1) Detect inside the app: OK. (2) Embeddings need not stay on the bundled server, because they are stored in SQLite and it does not matter which server creates them; running two Ollama servers only loads memory, so the bundled one is a fallback only. (3) Never switch silently: OK; give the user proper information and handle the required settings. (4) On-demand start and a setting that tells the app which server to use: a good idea, to be marked as a detailed design aspect. **Answer on fallback:** when the existing Ollama is gone, embeddings fall back to the bundled Ollama, and for chat a configurable default fallback model can be defined, which may be a cloud model.

**Detailed design aspects (to be designed, not decided).**
1. **Server selection settings.** Which server the app uses for chat and which for embeddings: automatic (an existing Ollama when it answers, otherwise the bundled one), the bundled one, or an existing one at a given address. Detection at start-up and when Settings opens, with a visible status.
2. **On-demand start** of the bundled server, so it only runs (and uses memory) when it is the server in use.
3. **Default fallback chat model** (a provider and model, possibly a cloud model) used when the chosen local server is unavailable. Claude's rule for the design: a cloud fallback sends the conversation off the machine, so it must be an explicit choice made by the user, shown clearly in the chat when it happens, and never silent.
4. **Embedding consistency guard (refined 2026-10-19 after Deepak asked whether identical weights already guarantee compatibility).** Answer: with the same weights the results are compatible for practical purposes (tiny floating-point differences between CPU, GPU and Metal builds do not matter to cosine search or to the 0.5 distance floor). Two things still make "same weights" an assumption and not a fact: (a) **the model is not bundled and not pinned.** The installer ships no model; first run makes the bundled Ollama download `nomic-embed-text` **by name** (`latest`) over the network, so two machines, or the same machine after a reinstall months later, can get different weights if the library updates that tag, and an existing Ollama may hold a different tag or quantization; (b) **the Ollama version.** Ollama has changed how embeddings are produced in the past (for example how returned vectors are normalized, and truncation), so the same weights on two server versions are not guaranteed to produce the same vectors; this is not verified for the pinned v0.40.3 against other versions. **Recommendation:** store the model's digest (Ollama reports it) with the search index and compare it when the server in use changes; on a mismatch show "needs rebuild" (the existing state) and tell the user; if Ollama can pull by digest, pin the embedding model to one digest. This is cheap insurance, not a blocker, and it matters even with a single bundled server because today the index records only the provider and model name.
5. **Informing the user.** What the user sees when the existing Ollama is found, when it stops or is uninstalled, and when a fallback is used.
6. **Port allocation:** first free port in 11450 to 11455, checked against ranges Windows reserves for itself.

### #224: guard the search index against a different embedding model (P1, new)

**Status: PROPOSED 2026-10-19 (Claude), bucket pending (proposed 0.4.0, size S).**

**What it is.** The search index records only the provider and model name. The embedding model is not shipped with the installer: first run makes the embedded Ollama download `nomic-embed-text` **by name** (the `latest` tag) over the network, so a reinstall months later, or another machine, can end up with different weights than the ones that built the index; and a different Ollama version can also change how embeddings are produced. Query vectors would then not match the stored ones and search would degrade silently.

**Proposal.** Store the model's digest (Ollama reports it) with the index, for example under an `app_settings` key (the persistence layer has no migration mechanism, so no `ALTER TABLE`). At start-up and when embedding, compare it with the digest the server reports; on a difference show the existing "needs rebuild" state and tell the user. If Ollama can pull a model by digest, pin the model to one digest. With one source (the embedded Ollama) this is cheap insurance, no longer a protection against two servers.

**Recommendation (Claude).** 0.4.0, size S; 0.3.2 is possible because it is in the same area as #214.

### #225: default fallback chat model when the local Ollama is unavailable (P1, new)

**Status: PROPOSED 2026-10-19 (Claude, from Deepak's idea), bucket pending (proposed 0.5.0 (detail), size M).**

**What it is.** Deepak's idea: a configurable default fallback chat model, which may be a cloud model, used when the user's local Ollama is not available. **Rule for the design:** a cloud fallback sends the conversation off the machine, so it must be an explicit choice made by the user, shown clearly in the chat when it happens, and never silent.

**Recommendation (Claude).** 0.5.0 (detail), designed together with `docs/auto_model_selection.md`, because both decide which model answers and how failures are handled.

## Closed during triage setup

| # | Item | Why closed |
|---|---|---|
| #121 | Anthropic caching: real-API check, cost model, 11b.7 | Closed 2026-10-19 by Deepak: all planned Anthropic work is done. |
| #137 | Everything needing an Anthropic key | Closed 2026-10-19 by Deepak: all planned Anthropic and Claude work is done. |
| #120 | Multi-model routing evaluation and replay probe | Closed 2026-10-19 by Deepak: the formal Claude evaluation was skipped on 2026-10-10 and the planned work is done. |
| #222 | Download models and run a Modelfile on the bundled Ollama | Closed 2026-10-19 by Deepak's hard decision: the embedded Ollama is for embeddings only; users manage models with their own Ollama. |
| #223 | Detect an existing Ollama; bundled Ollama on its own port | Closed 2026-10-19 (dissolved) by the hard decision; the surviving parts are in #214, #224 and #225. |

## P1 Bundled Ollama

| # | Item | Type | Proposed | Size | Why | Decision |
|---|---|---|---|---|---|---|
| #214 | Ollama chat provider and the bundled Ollama (final scope: embedded Ollama = embeddings only, own port; chat on the user's own Ollama) | defect + decision | 0.3.2 | S-M | The hard decision 2026-10-19: embedded Ollama only for embeddings (`nomic-embed-text`), port 11450 to 11455, never 11434; "Ollama (local)" hidden from the model selection when unavailable; Settings shows the address and install instructions. | **Decided 2026-10-19 (Deepak).** Small confirmations pending (questions 1, 2 and 5). |
| #224 | Embedding model digest guard for the search index | enhancement | 0.4.0 | S | Proposed by Claude; the model is pulled by name, not pinned. | proposed, pending (question 3) |
| #225 | Default fallback chat model (may be cloud) when the local Ollama is unavailable | feature | 0.5.0 (detail) | M | Deepak's idea; explicit, visible choice only; design with `docs/auto_model_selection.md`. | proposed, pending (question 4) |

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
