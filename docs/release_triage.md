# Release triage: 0.3.2, 0.4.0 and 0.5.0

Started 2026-10-19. This document is where the open backlog (`TASKS.md`) is sorted into the next releases, one point at a time, and where every decision is recorded. `TASKS.md` stays the record of each item; this file is the plan.

## Inputs

- **Release 0.3.1 is stable.** It is installed and running well on the sponsor's Windows 11 AMD64 machine (since 2026-10-18), with Anthropic, OpenAI and Tavily keys. The sponsor will read the User Guide and explore the application before giving feedback. That feedback will add items to this plan.
- **Target for 0.4.0:** no fixed date. Two weeks was the first goal; **Deepak relaxed it on 2026-10-19: there is no customer-defined deadline, so the plan can accommodate some change and the timeline is not a constraint.**
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
| 0.3.2 | 12 |
| 0.4.0 | 14 |
| 0.5.0 | 21 |
| Parked | 11 |
| Not this repo | 1 |
| Ongoing rule | 1 |
| **Total open items** | **60** |
| Closed during triage setup | 5 (#121, #137, #120, #222, #223) |

**Capacity note (updated 2026-10-19).** 0.4.0 is large (the PDF reader and video are L-sized, plus the Ollama block, Anthropic thinking, grep and the search items). Deepak has said not to worry about a two-week timeline because there is no customer deadline, so the release may simply take longer; we will still review the whole scope at the end and can split a release if it grows too big.

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
| P1 Bundled Ollama | #214, #224, #225 (#222 and #223 closed) | **DONE: all three go into 0.4.0** |
| P2 Planner and loop reliability | #140, #141, #146, #170, #191, #192, #226 (new) | **DONE 2026-10-19: #140, #141, #146, #170 in 0.3.2; #191, #192, #226 in 0.5.0** |
| P3 Everyday UX and trust | #215, #218, #227 (new), #216, #193, #168, #194, #189, #190 | **DONE 2026-10-19** |
| P4 Files and workspace | #204, #228 (new), #229 (new), #203, #169 | **DONE 2026-10-19** |
| P5 Documents | #196, #183, #197, #198, #85 | **DONE 2026-10-19: #196 in 0.4.0; #183, #197, #198, #85 in 0.5.0** |
| P6 Provider quality: cost, thinking and evaluation | #159, #134, #122, #135, #136 | **DONE 2026-10-19: #159 in 0.4.0; #134 in 0.3.2; #122, #135, #136 parked** |
| P7 Architecture | #124, #125, #127, #123, #205, #128, #132, #200, #49 | **DONE 2026-10-19: all nine items in 0.5.0 (detail); revisit after 0.4.0** |
| P8 Platform and distribution | #131, #208, #221, #220, #11, #63, #64, #65, #66 | **recommendations written 2026-10-19; presented, awaiting Deepak** |
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
| 2026-10-19 | P7 | #124, #125, #127, #123, #205, #128, #132, #200, #49 | **All 0.5.0 (detail); revisit after 0.4.0.** The merge of #205 into #123 (one design) was part of the proposal and is recorded as accepted. | Deepak: "All items for 0.5.0 so mark those, we will revisit after 0.4.0". |
| 2026-10-19 | P8 | #131 | **Parked in full** (no locks in 0.3.2). Counts now 0.3.2=12, Parked=11. | Deepak: too remote a corner case; an installed app does not normally run twice. Claude agrees: the race needs a double launch inside the first-run window. Revisit only if a user reports it. |
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
| 2026-10-19 | P1 | #214 | **Explicitly confirmed: the embedded Ollama is used for embeddings, the local Ollama for chat.** | Deepak: "Yes we will use embedded Ollama for embeddings and local Ollama for chat." |
| 2026-10-19 | P1 | #214 | **The "not running" behaviour is accepted** (the saved choice stays visible as "Ollama (local), not running", a clear error on send, no silent switch). **Availability is refreshed automatically, so no restart is needed.** | Deepak: "yes. refresh to avoid restart will be a good idea." (Claude's reading: this answers the earlier question about the not-running case; if it meant the editable address, that is also decided below.) |
| 2026-10-19 | P1 | #214 | **The Ollama address is editable in Settings, and the user may add an Ollama on the network.** | Deepak: "allowing user to add Ollama on network could be a good idea." |
| 2026-10-19 | P1 | #225 | **A fallback is NECESSARY: warn the user, then fall back, to avoid errors.** Raised from an optional idea to a needed feature; Claude proposes bucket 0.4.0 (size M), to confirm. | Deepak: "We should warn the user about it and then the fallback is necessary in order to avoid any errors." |
| 2026-10-19 | P1 | #214, #224, #225 | **All three go into 0.4.0.** #214 moves from 0.3.2 to 0.4.0. | Deepak: "This all goes in 0.4.0 now." Consequence recorded by Claude: the 0.3.x installers keep taking port 11434 for the embedded Ollama (and keep redirecting the "Ollama (local)" chat provider to it) until 0.4.0; that is accepted. The embedded server keeps starting at launch (today's behaviour, only on the new port); starting it on demand is a later option. |
| 2026-10-19 | P2 | #140, #141 | **0.3.2.** #140 reduced to logging the stop reason and token count of an empty planning reply, merged with #141; the Ollama comparison run is dropped. #141 = retry the planning call once when its reply is empty. | Deepak: "Ok" to questions 1 and 2. |
| 2026-10-19 | P2 | #146 | **0.3.2, option A, MCP Operator only:** do not offer the `delegate_to_mcp-operator` tool when no MCP server is connected (using the existing `isRoleAvailable`). | Deepak: "ok". |
| 2026-10-19 | P2 | #170 | **0.3.2:** reuse the #149 compact-summary logic in `collapseOldestToolResultsToFit`. | Deepak: "ok". |
| 2026-10-19 | P2 | #191 | **0.5.0 (detail).** The two split-off candidates (keep partial reasoning when a turn is stopped; stop the router re-verifying a delegate's files) are not done in 0.4.0; they are **handled together with #191 in 0.5.0**. | Deepak: "ok, no need, handle together in 0.5.0" (Claude's reading of the second half of answer 5). |
| 2026-10-19 | P2 | #192, #226 (new) | **#192: 0.5.0 with #191. New item #226 (after a failed step, point recovery at the saved handoff files and do not repeat the data query) created, bucket 0.5.0.** | Deepak: "Makes sense, in 0.5.0." |
| 2026-10-19 | P3 | #215 | **0.3.2** (role-prompt sentence, re-probe on small models, User Guide tip). | Deepak: "Looks good." |
| 2026-10-19 | P3 | #218, #227 (new) | **Split: the check in 0.3.2; new #227 (rules redesign: per MCP server, per connection) in 0.5.0 (detail).** | Deepak: "Ok." |
| 2026-10-19 | P3 | #216 | **0.4.0** (it touches the security boundary). | Deepak: "Ok." |
| 2026-10-19 | P3 | #193 | **0.3.2; the menu opens upward** (the picker is on the status bar at the bottom). | Deepak. |
| 2026-10-19 | P3 | #168 | **0.4.0**, with the Ollama block (#214). | Deepak: "Ok." |
| 2026-10-19 | P3 | #194 | **0.5.0 (detail).** | Deepak: "Ok." |
| 2026-10-19 | P3 | #189, #190 | **Both 0.4.0, built together.** | Deepak: "Ok." |
| 2026-10-19 | Plan | all | **The two-week timeline is relaxed**: no customer-defined deadline, so the plan can accommodate some change. | Deepak. |
| 2026-10-19 | P4 | #204 | **Deepak's file placement policy (recorded as stated):** (1) code generation must not happen in the workspace root; any tool that creates a file must know where to store it; (2) if the user asks to download a file it goes to the **download folder**; (3) any export goes to the **export folder** or a **folder the user chooses**; (4) if the user drops a file in, the drop accepts the **full path** of the file, not its contents, and the app may copy it into `tmp/` if needed; (5) GitHub clones already have their place (`.sachiv-clones`); (6) in general the **root is used very diligently**. | Deepak. Replaces the narrower view of #204 as "stop PNGs landing in the root". Open details are in the pending questions. |
| 2026-10-19 | P3 (added later) | #230 (new) | **New TODO from Deepak: ask the user to confirm before deleting a session. Bucket 0.3.2, size S (decided by Claude, because Deepak asked Claude to decide where it goes).** | Deepak: "When user deletes a session, we should get a confirmation from the user to avoid accidental deletion." Number #230 is used because #228 and #229 are reserved for the pending P4 proposals. |
| 2026-10-19 | P4 | #228 | **Downloads go to a workspace `downloads/` folder** (not the operating system's Downloads folder). | Deepak: "workspace downloads/". |
| 2026-10-19 | P4 | #228, #204 | **Exports go to a workspace `exports/` folder by default (including the Export Settings default); the native Save dialog stays for a folder the user chooses.** | Deepak: "yes". |
| 2026-10-19 | P4 | #228 | **File kind rules: `.md` always to `documents/`; `.csv` and `.json` to a new `data/` folder, except the session export (which goes to the export folder or the user-chosen folder); `.txt` to `documents/` for now, until a way is found to tell pure text from delimited data.** | Deepak. |
| 2026-10-19 | P4 | #229 (new) | **Drag and drop by path: new 0.4.0 item.** | Deepak: "Ok". |
| 2026-10-19 | P4 | #204, #228 | **Split by release: the small parts of #204 in 0.3.2; #228 and #229 in 0.4.0.** | Deepak: "ok". |
| 2026-10-19 | P4 | #203, #169 | **#203: 0.5.0 (detail). #169: 0.4.0.** | Deepak: "ok", "ok". |
| 2026-10-19 | P5 | #196, #183, #197, #198, #85 | **#196: 0.4.0 (L), spike first. #183, #197, #198, #85: 0.5.0 (detail).** | Deepak: "should work and agree" (#196, with a design addition: images, graphs and sketches in a PDF are extracted to a sub-folder of the temporary location and referred to while reading); "Ok" (#183); "Ok" (templates family). Downloads: if the user directs a download it goes to `downloads/`; otherwise a PDF opened for one-time reading stays in transient storage. |
| 2026-10-19 | P6 | #159, #134, #122, #135, #136 | **#159: 0.4.0 (M, opt-in, off by default, token budget in Settings). #134: 0.3.2 (S). #122, #135, #136: Parked, revisit after 0.5.0.** | Deepak: "Sounds good", "Ok, should do", "Fine for now, will revisit after 0.5.0". |

## Conflict raised and resolved (P1)

Option (a) as first described would have sent chat to the user's own Ollama and kept the bundled server for embeddings only, which conflicts with the requirement that the bundled Ollama be usable (download, Modelfile). **Resolved 2026-10-19 by Deepak, then changed the same day:** first the app was to use the bundled Ollama only, for chat and embeddings; later Deepak decided the bundled Ollama is a fallback that provides only embeddings, and the whole bundled-chat feature (#222) moves to 0.4.0. See the decision log.

## Pending questions (waiting for Deepak)

**P8 (details in "P8: item details and recommendations" below).**
1. **#131:** DECIDED: Parked in full (Deepak).
2. **#208:** 0.3.2 as a verification on your Mac, before shipping 0.3.2?
3. **#221:** 0.3.2 (S)?
4. **#220:** 0.5.0 (detail), with #210?
5. **#11, #63 to #66:** Parked, as decided? (Windows signing #65/#66 can be brought forward if the SmartScreen warning bothers the sponsor.)

## Item details and recommendations

### #214: the "Ollama (local)" chat provider is redirected to the bundled Ollama (P1)

**Status: FINAL SCOPE DECIDED 2026-10-19 (Deepak): bucket MOVED FROM 0.3.2 TO 0.4.0 ("This all goes in 0.4.0 now"). Scope: The embedded Ollama serves ONLY embeddings, always, with `nomic-embed-text`, on a non-standard port (range 11450 to 11455, first free, never 11434). The "Ollama (local)" chat provider uses the user's own Ollama and is hidden from the model selection when that is not available; Settings then shows the Ollama address and/or install instructions.**

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

**Confirmed on 2026-10-19 (Deepak):** embedded Ollama for embeddings and the local Ollama for chat; the not-running behaviour (visible as "Ollama (local), not running", clear error on send, no silent switch); availability refreshes automatically so no restart is needed; the Ollama address is editable and may point to an Ollama on the network.

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

**Status: DECIDED 2026-10-19 (Deepak): 0.4.0, size S.**

**What it is.** The search index records only the provider and model name. The embedding model is not shipped with the installer: first run makes the embedded Ollama download `nomic-embed-text` **by name** (the `latest` tag) over the network, so a reinstall months later, or another machine, can end up with different weights than the ones that built the index; and a different Ollama version can also change how embeddings are produced. Query vectors would then not match the stored ones and search would degrade silently.

**Proposal.** Store the model's digest (Ollama reports it) with the index, for example under an `app_settings` key (the persistence layer has no migration mechanism, so no `ALTER TABLE`). At start-up and when embedding, compare it with the digest the server reports; on a difference show the existing "needs rebuild" state and tell the user. If Ollama can pull a model by digest, pin the model to one digest. With one source (the embedded Ollama) this is cheap insurance, no longer a protection against two servers.

**Recommendation (Claude).** 0.4.0, size S; 0.3.2 is possible because it is in the same area as #214.

### #225: default fallback chat model when the local Ollama is unavailable (P1, new)

**Status: NEEDED (Deepak, 2026-10-19: "warn the user about it and then the fallback is necessary in order to avoid any errors"). DECIDED 2026-10-19 (Deepak): 0.4.0, size M.**

**What it is.** Deepak's idea: a configurable default fallback chat model, which may be a cloud model, used when the user's local Ollama is not available. **Rule for the design:** a cloud fallback sends the conversation off the machine, so it must be an explicit choice made by the user, shown clearly in the chat when it happens, and never silent.

**Recommendation (Claude, revised 2026-10-19).** Since the fallback is necessary to avoid errors, bring it forward to **0.4.0, size M**: a Settings choice of the fallback model (provider and model, possibly cloud), used only when the selected local Ollama is not reachable; a visible warning in the chat each time it is used, naming the model and saying the conversation is going there; if no fallback is configured, a clear error and no silent switch. The deeper automatic-selection ideas stay in `docs/auto_model_selection.md`.

### P2: item details and recommendations (written 2026-10-19, before presenting; ALL DECIDED, see the decision log)

#### #140: record why a planning reply was empty

**What it is.** `scripts/plan-probe.mts` prints nothing about an empty planning reply beyond `BAD ... ""`. The item asks for the stop reason and the output-token count (and whether hidden reasoning was used) for every empty or invalid reply, then a re-run of the Ollama `gpt-oss-custom` comparison (5 repetitions, both modes) to confirm the suspected cause: the model's hidden reasoning uses up the output budget before any visible text (#139 measured 4 of 40 prompt-only and 7 of 40 structured replies empty, none malformed). It also asks whether the empty rate changes with `--max-tokens` (4096 to 8192).

**Why it matters.** Without the reason, an empty planning reply is a mystery, and #141's second option (a larger output budget) cannot be chosen on evidence. It is a diagnostic, not a product feature.

**Recommendation (Claude): 0.3.2, reduced scope, done together with #141. Size S.**
- Keep: when the planning reply is empty or invalid, record the stop reason and output-token count in the existing console warning in `classifyAndPlan`, and in the `plan-probe` output.
- Drop: the five-repetition Ollama comparison. It is local-model research that the fix does not need; #141's option (a) "depends on #140 for the choice, not for (a)".
- Reason: tiny, no product risk, and it makes any future empty-reply report explainable on any provider.

#### #141: recover from an empty planning reply

**What it is.** `classifyAndPlan` fails open to "no plan" when the planning reply is empty. A compound request (for example the PLF question, which needs the wiki and the database) then loses its split and the router works alone (#138). **Fix, in order of preference:** (a) retry the planning call once when the reply is empty (it mirrors the round-loop recovery from #138 and costs one extra call only on failure, about 25 s on a local gpt-oss); (b) a larger output budget for this call, if #140 shows that hidden reasoning starved the output. Tests with the mock provider: empty then valid; empty twice still fails open with the warning staying console-only.

**Why it matters for the sponsor.** The measured cases are on a local model, but any reasoning model can spend its output budget on hidden reasoning before visible text (plausible for OpenAI reasoning models; not verified here). A silent downgrade from a split plan to "router alone" gives a worse answer with no sign of why.

**Recommendation (Claude): 0.3.2, size S.** A defect with silent degradation, a small contained change (one retry), no dependencies, and an extra call only on failure.

#### #146: MCP-availability substitution for the single-step path

**What it is.** #145 substitutes the Researcher when no MCP server is connected, but only for **plans of two or more steps** (`executePlan`). A plan with one step, or a `simple` classification, runs through the ordinary top-level round, where the model can call `delegate_to_mcp-operator` with no availability information in front of it.

**Verified in the code on 2026-10-19.** `buildDelegateToolDefinitions()` (`orchestrator.ts`, about line 1945) builds a delegate tool for **every** agent, regardless of whether it is available, and the top-level round uses it (about line 1759). So with no MCP server connected the model is still offered the MCP Operator. This is plausibly the more common case (a plain "look this up in the wiki" request).

**The item's two design questions, and a simpler answer.** The item proposed redirecting inside `dispatchDelegate`, which leaves a mismatch: the tool call shown in the transcript still names `mcp-operator`. **Simpler option (A):** do not offer the delegate tool for a role whose requirement is unmet, using the existing `isRoleAvailable` (the same check that already produces "UNAVAILABLE right now" for the planner). Then the model never calls it, there is no attribution mismatch (design question 1 disappears), and the model is less likely to try it at all (design question 2). **Option (B):** the redirect as the item described.

**Recommendation (Claude): 0.3.2, size S, option (A), for the MCP Operator only** (mirroring #145). Generalizing to every role with an unmet requirement (a database role with no database, the email role with no account) is a one-line extension but changes behaviour for more roles; evaluate it separately. Tests: with `config.mcp === 0` the top-level tool list has no `delegate_to_mcp-operator`; with `config.mcp > 0` it does; existing single-step and `executePlan` suites still pass unchanged.

#### #170: keep a compact summary when collapsing old tool results

**What it is.** `collapseOldestToolResultsToFit` still replaces every non-mutating tool result it collapses with the content-free `CONTEXT_FIT_OMITTED_MARKER`, the flaw #149 already fixed for `capRepeatedToolResults`. It has one call site (`refitConversationToBudget`), which the `MAX_TOTAL_ROUNDS` wrap-up path also reuses, so one fix covers both. It is reuse of the already-built `LISTING_TOOL_NAMES` and `compactListing` logic: the trigger differs (budget pressure, not repetition count) but the output shape should be identical. The item itself says no discussion is needed.

**Why it matters.** In a long session on any model, old results are silently replaced by an empty marker, so the model loses what a tool returned.

**Recommendation (Claude): 0.3.2, size S.** Applying a decided pattern, low risk, with tests like #149's.

#### #191: reasoning-loop breaker for local models

**What it is.** Found in manual test 8.2 on `ollama:gpt-oss-custom`: the model's thinking degenerated into one sentence repeated about 100 times (9.7K characters), the round took about 2 minutes, and the step ended with an apology that the orchestrator accepted as finished. Nothing watches for a stream that is full of output and going nowhere (existing recovery covers empty replies, truncated tool calls, round timeouts and repeated failing calls). **Idea:** while a round streams, watch the accumulated thinking and text; when the same normalised sentence repeats N times, or a long tail repeats the text before it, abort the round, retry once with a short nudge, and fail the step clearly if it loops again. **A second occurrence (2026-10-10)** showed the router re-checking a delegate's finished work with its own tool call, then reasoning for 2 min 19 s until the user pressed Stop; and reasoning cut off by Stop is not saved, so such loops can only be diagnosed while running.

**Open design questions.** How to detect a loop without cutting off legitimate repetition (lists, tables, code); thresholds for thinking versus visible text; abort the stream or discard it afterwards; how the retry avoids the same loop; where it lives (`runLoop` stream handling, shared by every role) and how it interacts with the round timeout and the empty-response retry; how to test it.

**Evidence first.** How often it happens across sessions and models (the stored `thinking` blocks are enough to count). The same run on Gemini finished in about 30 seconds with no loop. That evidence is on the sponsor-less machines (the sessions are on Deepak's Mac); this machine has no app data now.

**Recommendation (Claude): 0.5.0 (detail), size M.** Local models remain a supported path (the user's own Ollama), but this needs evidence and several design choices before building, and it does not affect the sponsor, who uses cloud models. **Small candidates split off, for Deepak to choose:** (a) keep the partial reasoning text when a turn is stopped, so loops can be diagnosed (size S, could go into 0.4.0); (b) tell the router in code that a direct delegate's files were created and checked, so it passes the answer on instead of re-verifying (size S to M, applies to cloud models too, needs a small design).

#### #192: keep each plan step to its own job

**What it is.** In the same session a plan step for Data Access ("query the Northwind database") reasoned about the whole request (the Word document), because the original user message is still in its conversation, which led to the loop in #191. **Idea:** when `executePlan` hands a step to a specialist, append a fixed line naming the boundary: "Do only this step. The remaining steps (<role: short description>) are done afterwards by other specialists; do not attempt them." Built from the plan itself, one short sentence per step. **Related, not yet an item:** when a step fails and the top level retries, the retry started from scratch (the data query ran three times) even though the first result was already saved under `.sachiv-handoff/`; pointing recovery at the existing files would fix that.

**Open questions.** Whether the line measurably changes behaviour on small models (a prompt line is only a suggestion to a weak model; compare runs with and without it, counting tool calls and rounds); whether it is needed on cloud models, which did not drift in the Gemini run; the effect on the prompt-size ceilings; where the original request should appear in a step's conversation (full text or only the step's task), which is the root of the drift.

**Recommendation (Claude): 0.5.0 (detail), size M, designed together with #191.** **New candidate item, for Deepak to decide (proposed #226):** "after a failed step, point recovery at the existing handoff files instead of repeating the data query". It wastes real database queries and applies to cloud models too; proposed size M, bucket 0.4.0 or 0.5.0.

### P3: item details and recommendations (written 2026-10-19, before presenting; ALL DECIDED, see the decision log)

**Capacity note.** Everything proposed for 0.4.0 so far is far more than two weeks of work. Deepak later said the two-week timeline does not matter (no customer deadline), so this is only a note that the whole scope is reviewed at the end.

#### #215: a pinned specialist does not state its role when greeted

**What it is.** `docs/manual_testing.md` 11.6 expects that after pinning a specialist in the Agent picker and saying hello, it states its own role. Probed on 2026-10-15 without the UI: on `gpt-4o-mini` all 12 pinned roles answered a bare greeting ("Hello! How can I assist you today?") and answered "What can you do?" with a generic "tell me what you need"; only Auto gave a real list. On `claude-haiku-5-5` every role answered correctly (a role statement plus abilities). So the failure is **model-dependent**. Deepak's requirement (2026-10-15): do not write it off as a weak model; the model is meant to learn what it can do from its tools (`describe_capabilities`, `get_environment`), and the weakest supported models must handle a greeting well.

**Direction.** Check whether pinned roles even have those tools; add to each role prompt that when greeted or asked what it can do, it states its role and its main abilities (and may call `describe_capabilities`). Docs follow-up already decided: add the "pick a role, send Hello" tip to `docs/user-guide/05-agents-and-roles.md`.

**Costs and risks.** A sentence added to 12 role prompts raises the prompt-size ceilings in `prompt-budget.test.ts`; measure it. The evidence is one small model; re-probe after the change on `gpt-4o-mini` and a second small model.

**Recommendation (Claude): 0.3.2, size S to M.** It is a defect against documented behaviour, and the sponsor, who has an OpenAI key and is exploring the application, is exactly the person who will pin a role and say hello.

#### #218: check Settings > Auto-approve rules

**What it is.** Deepak saw `mcp_llmwiki` rows in the Auto-approve list and asked for a thorough check. A quick look found the list is generated from the live registry: every tool whose `mutates` is true or a function gets a checkbox, so an MCP server's tools appear as individual `mcp__<server>__<tool>` rows. The thorough check must answer six things: (1) exactly which names appear and why, and whether `mcp_llmwiki` is a tool, a stale entry or a name-format problem; (2) one row per MCP tool can mean dozens of rows per server (consider a rule per server with per-tool exceptions, grouped by source); (3) a rule on the generic database and API tools applies to **all** connections (a rule per connection may be wanted); (4) the list is loaded once, so it goes stale when a server connects or a connection is added, and rules for tools that no longer exist stay stored; (5) safety: a rule on a tool that only sometimes mutates approves all its calls (SQL writes included), so the warning must be clear, and outside-workspace folder access must stay never auto-approved; (6) update the User Guide (pages 04, 10 and 11), the Developer Guide and `docs/manual_testing.md`.

**Recommendation (Claude): split it.**
- **0.3.2, size S to M: the check itself** (questions 1, 4, 5 and 6): explain the rows, refresh the list when a server connects, drop stored rules for tools that no longer exist, make the warning for "sometimes mutates" tools clear, and confirm the outside-folder rule. Safety-related and small.
- **New item #227, bucket 0.5.0 (detail), size M to L: redesign the rules** (questions 2 and 3): rules per MCP server with exceptions, grouping by source, and per-connection rules for databases and APIs. A design task, not a patch.

#### #216: grant folder access up front in Settings

**What it is.** Settings > Workspace > "Folders outside the workspace" only lists folders the user chose "Always" for in a chat prompt, and offers only Remove. Deepak wants an **Add folder...** button (native folder picker) to grant access to places such as Downloads, Desktop or Documents in advance. To settle: the grant is the same read-only grant as "Always" (creating a new file outside still asks each time); the blocked list (`.ssh`, `.aws`, keychains, the app's own data) must still win, and the picker must refuse the home directory or a drive root as too broad; quick-add shortcuts for the usual folders; de-duplicate and normalise paths; docs and a manual test case.

**Recommendation (Claude): 0.4.0, size M.** It removes a repeated confirmation for a non-developer user, but it sits on the **security boundary**, so it needs careful tests (a blocked folder refused; a grant honoured with no prompt) and should not be a patch-release change.

#### #193: Agent picker opens a menu instead of cycling

**What it is.** The `Agent: <name>` button in the chat status bar rotates through Auto and every enabled role on each click, so reaching a specific role means clicking through the others. Wanted: a click opens a menu listing Auto and every pickable, enabled role (user-defined roles included), the current choice marked; it opens **upward** (the status bar is at the bottom; the request said "now down", read as "not down", to confirm); closes on outside click, Esc or selection; keyboard use with focus returned; Ctrl+Tab cycling stays and the tooltip is updated; a one-line purpose per role if the roster has one. It needs a live check in a throwaway Electron copy.

**Recommendation (Claude): 0.3.2, size S.** UI-only, low risk, and a visible improvement for someone exploring the 12 specialists.

#### #168: Ollama Cloud usage shown as $0

**What it is.** `isLocalModelId()` decides a model is free and local from the shape of its id (`name:tag`). Ollama Cloud ids such as `gemma4:cloud` match that shape, so real, billed Ollama Cloud usage can be shown as $0; `gpt-oss:120b-cloud` does not match and shows "cost unknown". A proper fix needs an optional provider id threaded through `estimateCost` and `contextWindowFor` and into `ContextMeter.svelte` (none of their call sites has the provider today). Cloud costs can stay "unknown" once they are not mistaken for free.

**Recommendation (Claude): 0.4.0, size S to M, with the Ollama block (#214).** It affects only Ollama Cloud users, not the sponsor, and the plumbing is easier to design together with the provider changes in #214. The item itself says not to implement it before testing with real Ollama Cloud usage.

#### #194: group the session list by date

**What it is.** A configurable setting "Group sessions by date" that shows the left pane as expandable groups (Today, Yesterday, Previous 7 days, then months) instead of one long list. Renderer-only; many details were already worked out (group by last activity, local time, the active session's group auto-expands, activity indicators visible on a collapsed header, per-group state remembered, keyboard and screen-reader use).

**Recommendation (Claude): 0.5.0 (detail), size M.** Nice to have, but search (#189, #190) helps more once sessions pile up. It is the first item to cut when 0.4.0 is over capacity.

#### #189: search across past conversations

**What it is.** A magnifier in the left pane that searches the stored messages of all sessions for text the user remembers, shows a list (session title, a snippet with the match highlighted, date) and opens the session, ideally scrolled to the matching message. Open design questions: where the input lives; the matching engine (SQLite FTS5 versus plain `LIKE`); whether to index tool output (huge and noisy) or only user and assistant text; structured message blocks; result limits and debouncing; the shortcut; jump-to-message; whether deleted sessions are included.

**Recommendation (Claude): 0.4.0, size M.** Plain matching over message text is enough at personal scale; leave tool output out at first. Note that the memory index (vector search) is agent-facing and a different feature.

#### #190: find within the current session

**What it is.** Ctrl+F (Cmd+F on macOS) searches the current session's transcript. Share the matching code with #189 and keep the shortcuts distinct. Open: a find bar (match count, next and previous, Esc) versus Electron's `webContents.findInPage`; whether collapsed tool blocks are searched and auto-expanded; long or lazily rendered sessions; highlighting inside KaTeX, Mermaid and code blocks; not hijacking the shortcut while the message box or Settings has focus.

**Recommendation (Claude): 0.4.0, size M, built with #189.** Ctrl+F is expected in a chat window; Electron's built-in find is the cheapest start.

#### #230: confirm before deleting a session (added 2026-10-19, after P3 was decided)

**What it is (Deepak's TODO).** When the user deletes a session, ask for confirmation, to avoid accidental deletion.

**What the code does today (checked 2026-10-19).** The small **x** button on a session row (`SessionList.svelte`) calls `removeSession` in `App.svelte`, which deletes at once with **no confirmation**. The delete is permanent: `deleteSession` removes the chat's messages, token usage, search-index chunks and their vectors in one transaction, and there is no recycle bin. One more quirk: if the session is the open one, or is generating, `removeSession` returns silently and nothing visible happens.

**Where it goes (Claude's decision, as Deepak asked): 0.3.2, size S.** It is a data-loss safeguard on an irreversible action, a small UI change with no effect on the engine, in the same family as the other 0.3.2 UX items.

**What to build.**
- An in-app confirmation (a small modal in the app's own style, not the browser `confirm`) that names the session title and says the chat, its saved usage and its search-index entries are removed and **cannot be undone**; buttons **Delete** and **Cancel**; focus on **Cancel** and Esc cancels, so an accidental Enter or click does not delete.
- Tell the user why nothing happens when they try to delete the open or a running session (a short message: switch to another session, or wait/stop), instead of silence.
- Nice, optional: mention that the chat can be exported first (the export button already exists).
- Tests and docs: a check that Cancel keeps the session and Delete removes it; a manual-test case; one line in User Guide page 04 (sessions).

**Alternative considered, not chosen.** A soft delete with an "Undo" toast for a few seconds is friendlier but needs a soft-delete state and a purge timer, which is a bigger change. The confirmation is what Deepak asked for.

### P4: item details and recommendations (written 2026-10-19, before presenting; ALL DECIDED, see the decision log)

#### #204: files landing in the workspace root

**What it is.** The user's workspace root held 129 loose files. Where they came from (from the session database and the tool calls):
1. **122 PNGs** (`p2_0..33.png`, `page_*.png`, `crop_p2_*`, `bio_detail.png`, `hounslow_weather_forecast.png`), written by `python_run` scripts with bare relative names such as `plt.savefig("x.png")`. Scripts run with the workspace root as their working directory, so a bare name lands there. The "file by kind" filing in `workspace-layout.ts` only applies to files written through the file tools, not to what a script writes itself.
2. **Research notes** (three `.md` and `.txt` files) written by the Researcher; a fix sending them to `tmp/` landed on 2026-10-09 and these may predate it (not checked).
3. `filedetails.csv`: the request itself said "in the workspace root" (an explicit instruction).
4. `sachivji-settings-export.json`: the Export Settings dialog's own default folder is the workspace root (`settings/import-export.ts`).
5. `UMLS.sqlite` (286 MB): probably placed by the user.

**Ideas in the item.** After each `python_run` or `shell_execute` the app already snapshots the workspace to report created files ("verified by the app"); use it to move new root files into the right folder by kind and tell the model the new path. Or run scripts with `tmp/` as the working directory and give real paths for inputs. Make the prompts and `get_environment` say explicitly where outputs go (images to `resources/`, documents to `documents/`, scratch to `tmp/`). Change the Export Settings default folder. Add a root-hygiene check. Decide together with #203.

**Why a split is safer.** Moving files after a run is the effective fix but has real traps: a user who explicitly asked for a file in the root (item 3) must be respected; a script that writes a file and a later run that reads it by the old name would break; and changing the working directory breaks scripts that read inputs by bare name.

**Recommendation (Claude): split.**
- **0.3.2, size S: the cheap, safe parts.** (a) Say explicitly in the Developer prompt and in `get_environment` where outputs go and that scripts should write images to `resources/`, documents to `documents/` and scratch to `tmp/`. (b) Change the Export Settings default folder; Claude's suggestion is the operating system's Documents folder, because a settings file is not a work product. (c) Check whether the three research notes predate the 2026-10-09 fix.
- **New item #228, 0.4.0, size M: move script outputs after a run.** Needs a safe rule first: only move new root files of generated kinds (images, scratch data), never when the request named the root, always tell the model the new path, and report what was moved. Design it together with #203.

#### #204 update (2026-10-19): Deepak's placement policy, and a code check that corrects my first write-up (final scope below; DECIDED)

**Correction.** The write-up above (and `TASKS.md` #204, "fix not started") missed that part of the fix **already exists**. Checked in the code on 2026-10-19:
- `resolveNewFilePath` (`tools/workspace-layout.ts`) sends new files written through the file tools to `code/`, `documents/` or `resources/` by extension, and leaves `templates/`, `.sachiv-clones/` and `tmp/` alone. A file whose extension has no managed folder (`.csv`, `.json`, `.md`, `.txt` and so on) **stays in the workspace root**: the 2026-09-23 rule says "everything else at the workspace root".
- **`tidyRootStrays` already exists** (added 2026-10-06, commit `844f7b8`): after a `python_run`, if **four or more** new loose files appear in the root, they are filed by kind and anything else goes to `tmp/`; fewer than four stay, on the assumption that one or two are the deliverable the user asked for. It is called only from `python_run`; **`shell_execute` does not call it**.
- `download_image` saves into `resources/`; there is **no general "download a file" tool** (and so no download folder).
- The chat export uses the native Save dialog (a folder the user chooses); the Export Settings dialog defaults to the **workspace root**.
- **There is no drag-and-drop handling at all in the renderer today.** Dropping a file on the window is not a feature yet.
So my proposed "#228, move script outputs after a run" is **mostly done**; what remains is extending and tightening it.

**What Deepak's policy adds, mapped to the gaps.**

| Policy point | What exists today | Gap |
|---|---|---|
| Code is never generated in the root | File tools put code in `code/`; scripts write wherever they run (the root); the sweep needs 4+ files and only runs after `python_run` | Sweep after `shell_execute` too; one or two stray files stay; scripts should be told, and given, a place to write |
| Downloads go to the download folder | No download tool; images go to `resources/` | A download folder and a download tool (the PDF reader #196 will need it) |
| Exports go to the export folder or a user-chosen folder | Chat export: user-chosen via the Save dialog; Export Settings: workspace root | An export folder as the default; Export Settings default changed |
| A dropped file passes its full path, not its contents; may be copied to `tmp/` | No drop handling | A new feature: drop onto the composer inserts the path(s) |
| Clones have their place | `.sachiv-clones` | none |
| The root is used very diligently | `.csv`, `.json`, `.md`, `.txt` files created by `write_file` land in the root | A rule for those kinds of files, so nothing generated lands in the root by default |

**Claude's proposal.**
- **Folders (all inside the workspace, so no confirmation dialogs):** `downloads/` for downloaded files and `exports/` for exports, plus the existing `code/`, `documents/`, `resources/`, `tmp/`, `templates/`, `.sachiv-clones/`. A native Save dialog stays for anything the user chooses interactively, with `exports/` as its default folder. Writing into the operating system's own Downloads folder instead would be a standing write permission outside the workspace, which is a security-sensitive design (today an outside write asks every time), so I do not recommend it.
- **Generated `.csv`, `.json`, `.md`, `.txt` files:** `documents/` (users think of these as deliverables), with scratch versions in `tmp/`. An explicit user request for the root is still honoured.
- **One code-owned destination table** for the whole app (kind of file to folder), used by every tool that creates a file, so that "any tool that generates a file knows where to store it" is true by construction. This is the reframed #228.
- **Drag and drop by path** as a new item (#229): a file dropped onto the composer inserts its full path(s) into the message, not its contents. In Electron 32 and later the renderer reads the path through `webUtils.getPathForFile` in the preload (to verify for the project's Electron 44). A path outside the workspace is covered by the existing external-folder read prompt; when a file must be inside the workspace (for a script), the app copies it to `tmp/`. Copies in `tmp/` are pruned after 7 days (the interplay with #203).

**Proposed split by release.**
- **0.3.2, size S to M:** the Developer prompt and `get_environment` say where each kind of output goes; the sweep also runs after `shell_execute`; the Export Settings default moves out of the root (to `exports/`).
- **0.4.0, size M:** the destination table (#228 reframed), the `downloads/` and `exports/` folders, and the generated `.csv`, `.json`, `.md` and `.txt` rule.
- **0.4.0, size M:** drag and drop by path (#229, new).
- **0.5.0 (detail):** cleanup of the new folders belongs to #203.

**FINAL SCOPE (decided 2026-10-19, Deepak).**
- **#204, 0.3.2, size S to M:** (1) the Developer prompt and `get_environment` say where each kind of output goes, using only the folders that exist in 0.3.2 (`code/`, `documents/`, `resources/`, `tmp/`, and `exports/` for exports); the wording is updated again when #228 adds the new folders; (2) the sweep (`tidyRootStrays`) also runs after `shell_execute`; (3) the Export Settings dialog defaults to the workspace `exports/` folder (created if missing), not the root; (4) check whether the three old research notes predate the 2026-10-09 fix.
- **#228, 0.4.0, size M: one code-owned destination table** (kind of file to folder), used by every tool that creates a file: `code/` (code), `documents/` (office documents, PDF, `.md`, and `.txt` for now), `resources/` (images, audio, video), **`data/` (new: `.csv` and `.json`; not the session export)**, **`downloads/` (new: downloaded files)**, **`exports/` (new: exports)**, `tmp/` (scratch), `templates/`, `.sachiv-clones/`. Nothing generated lands in the root unless the user explicitly asks for the root. Later refinement noted by Deepak: find a way to tell pure `.txt` text from delimited data. Open for the design (not yet decided): other structured formats (`.tsv`, `.xml`, `.sqlite`, `.parquet`); a download tool (the PDF reader #196 will need one).
- **#229, 0.4.0, size M: drag and drop by path.** A file dropped onto the composer inserts its full path(s) in the message, not its contents (`webUtils.getPathForFile` in the preload; to verify for Electron 44); a path outside the workspace uses the existing external-folder read prompt; the app copies the file to `tmp/` only when a script needs it there (copies are pruned after 7 days; see #203).
- **#203, 0.5.0 (detail):** cleanup of all these folders. **#169, 0.4.0:** the content search tool.

#### #203: design a workspace cleanup mechanism

**What it is.** Today the only cleanup runs at the start of each chat turn: files in `tmp/` and `.sachiv-handoff/` older than 7 days are deleted (`pruneScratchDir`, `pruneHandoffDirs`); it is best-effort, runs only while chatting, is not configurable, and the prompt only says "cleaned up after a few days". Nothing covers `documents/`, `resources/`, `code/`, `templates/`, loose root files, or `.sachiv-clones/` (1,075 files, about 75% of the files in the user's workspace outside `venv`; what it holds and when the app is done with it was not checked). Design questions: which folders are scratch and which are the user's work (never delete those without asking); retention per folder and whether the user can set it (the user thought 30 days); when it runs (turn start, app start, a timer) and whether it reports what it removed; a "Clean up now" button with a preview; protecting files a later step may still need; size limits as well as age (a 286 MB file sits in the root).

**Recommendation (Claude): 0.5.0 (detail), size M.** It is a design task with real data-loss risk, so it must be designed carefully and not rushed into a patch. #204 stops the worst source of clutter first. First step when it is picked up: find out what `.sachiv-clones/` holds.

#### #169: `grep` / `find_in_files` content search

**What it is.** A tool that searches file contents across the workspace through the same `WorkspaceGuard` as every file tool, split out of #148. Design points already named: a binary-file guard reusing the extension and content checks that `write_file` and `show_media` already use; how much context per hit (like `grep -C`); and the sharper risk, result-size explosion. Apply the #148 and #149 principle (cap the view, never silently drop data the model needs): a per-file match cap and a total-file cap with the same honest "showing first N, narrow your pattern" wording `find_files` uses.

**Recommendation (Claude): 0.4.0, size M.** The design is already mostly settled in the item. A cross-platform tool also matters because the shell tool on Windows has no `grep`, and the sponsor is on Windows. Work: the tool, its owner role, the prompt-budget ceilings, tests (binary file, caps), the tool catalog and the guides.

### P5: item details and recommendations (DECIDED 2026-10-19)

**Decided 2026-10-19 (Deepak):** #196 in 0.4.0 (agreed, with the extraction design addition below); #183, #197, #198 and #85 in 0.5.0 (detail), the last three as one templates family; a PDF the user directs to download goes to `downloads/`, a PDF opened only to be read stays in transient storage.

**Design addition for #196 (Deepak):** reading a PDF extracts its text to a temporary location, and any images, graphs or sketches in the PDF are extracted to a sub-folder of that temporary location, so the model can refer to them while reading and interpreting the PDF. (Open for the design: how the model sees them, since images reach it only through a vision-capable model or OCR; this ties to #183. Extracted images are cleaned up with the temporary location.)

**Context.** The sponsor is a non-developer on Windows who uses Anthropic, OpenAI and Tavily web search, so web research and documents are his likely work. The installers bundle Python, so Python-based document tools are available to installed users.

#### #196: a PDF reader

**What it is.** Web research keeps hitting PDFs (standards previews, white papers) and the app can only say it cannot read them (`parse_html` refuses PDFs on purpose, because a large PDF once stalled the app); and a user who hands the app a PDF has no route except the Developer writing a one-off script (`read_file` refuses `.pdf`). Wanted: a tool that converts a PDF once to Markdown, keeps it out of the context, and lets the model read it in sections or search it.

**Researched design (2026-10-09, in the item).**
- **Tools: two, to keep the prompt small.** `pdf_open` converts once (stored per session, not in the user-visible workspace) and returns a small summary (title, page count, outline with page numbers, whether a text layer exists); `pdf_read` takes a page range, a heading or a `query` and returns one section with a size cap, or search hits with page numbers and snippets.
- **Integration with web research.** `parse_html` and `read_file` on a PDF should hand it to the same converter and return the summary plus the first section, so every existing path that opens search-result links works unchanged; `web_search` stays a search but marks PDF results as `[PDF]`.
- **Engine (leading candidate): `@llamaindex/liteparse`** (Apache-2.0): a native addon over PDFium with prebuilt binaries for macOS, Windows and Linux (about 25 MB per platform), Markdown output with real tables and headings, a worker pool with a hard per-parse timeout (answers "a bad PDF must not stall the app"), and **built-in Tesseract OCR**. Trials: a 17-page deck in 0.56 s and a 15-page paper in 0.05 s; tables kept as Markdown tables (header rows sometimes mangled). Caveats: a young project; OCR downloads a 15 MB language file on first use, so an offline install must bundle it; not yet tried inside Electron 44. **Fallback: `unpdf`** (MIT, pure JavaScript, plain text only, so heading and section logic would be our own). Ruled out for licence reasons: `mupdf` and PyMuPDF (AGPL).
- **Guards:** URLs downloaded with a size cap, `%PDF-` sniffed and not trusted from the Content-Type, private and loopback hosts refused, same confirmation rules as `download_image`; scanned PDFs (no text layer) detected and reported, not returned empty (linked to #183); extracted text treated as untrusted data, never as instructions; internal conversion files never named in answers.
- **Costs:** the tool schemas raise the prompt-size ceilings deliberately; converting a 100+ page PDF takes seconds, so it needs a progress status and must respect the turn deadline and run off the main thread.
- **Knock-on:** the `parse_html` refusal message and Research's "open these now with `parse_html`" check must route PDF links to the new path; the guides and tool catalog.

**Recommendation (Claude): 0.4.0, size L.** The most valuable item in this point for a web-research user. **Order of work:** (1) a spike, size S to M: run LiteParse inside a throwaway Electron 44 copy on Windows and macOS (native load from `app.asar.unpacked`, worker pool, packaging); if it fails, fall back to `unpdf` plus our own section logic; (2) the two tools and the `parse_html` / `read_file` hand-off; (3) the guards, tests with small generated PDFs (text, two columns, a table, image-only), a live check on the IEC 61400-26 question and a local PDF, the docs. It depends on **#228** for a download tool and folder if the user explicitly asks to download a PDF (a PDF merely being read stays in temporary storage).

#### #183: read text from images and scanned documents (OCR)

**What it is.** Found when a scanned passport PDF had no text layer: the model could only display the image, called `show_media` 82 times and then invented the expiry date. Two routes: a built-in OCR tool (offline; MRZ parsing would give an exact passport expiry) or sending images to a vision-capable model (reverses the earlier decision that the model never sees pixels; costs tokens). An interim rule already forbids stating a value that could not be read.

**What has changed.** The PDF engine candidate for #196 includes Tesseract OCR (an image-only slide worked at about 3 s a page), so most scanned PDFs may be covered by #196. Vision models are available to the sponsor (Anthropic, OpenAI), but a passport or similar scan sent to a cloud model is a privacy decision.

**Recommendation (Claude): 0.5.0 (detail), size L, re-evaluated after the #196 spike.** If LiteParse's OCR works inside Electron, a minimal "scanned PDF to text" comes with #196; what remains is standalone images and MRZ parsing. The design decisions to document in 0.5.0: bundle or download the OCR language data for offline installs, local OCR versus a vision model, and an explicit user choice before an image leaves the machine.

#### #197: build a deck from the user's own PowerPoint template

**What it is.** The deck tools (PptxGenJS) draw slides from scratch and cannot load a template, so "use the template in the workspace" produces a plain deck. Proposed shape: `pptx_start_deck` takes an optional `template` (a `.pptx` or `.potx` under `templates/`), the deck starts as a copy with its sample slides removed, and the result lists the template's layouts compactly; `pptx_compose_slide` takes a `layout` name and `placeholders` (text, bullets or an image) and may still carry free elements; `pptx_save_deck` writes the file. **Engine recommended in the item:** `python-pptx` through the managed Python environment (the mature library for layouts and placeholders; hand-written OOXML is the risk, after a session of repair prompts from PptxGenJS output). Costs: `python-pptx` is not in the base packages, so it must be added pinned (including its native wheels for the bundled Windows wheelhouse) and installed on first use for existing workspaces. Real templates need: empty placeholders removed, layout fallback when names repeat, a warning when text is far longer than its placeholder, template fonts and colours kept, pictures cropped to fill.

**Recommendation (Claude): 0.5.0 (detail), size L, designed together with #198 and #85 as one "templates" family.** The item's open questions can be answered now: Python is available in the installers, so requiring it is acceptable if the tool says clearly when Python is off; keep only the template's layouts at first and treat its sample slides as an optional later extension.

#### #198: template generation from an existing document

**What it is.** `office_extract_template` plus `office_fill_template` made a template that was "far from acceptable" (a resume turned into a template was about 95% the original). Done on 2026-10-10 (not seen live): `apply` matches across the runs of a paragraph, reports content still left, and the prompts ask for a section-by-section list. **Still wrong:** repeating blocks need loops (`{#jobs}...{/jobs}`), whole-paragraph placeholders are clumsy, deciding what is variable is judgement a weak model gets wrong (consider a structure-first pass where the model marks each section fixed, field or loop), headers, footers, text boxes, tracked changes and fields are unchecked, there is no verification step, the placeholder syntax should follow a survey of good products (Word content controls, docxtemplater, mail merge), and the first test was only slim router plus Haiku.

**Recommendation (Claude): 0.5.0 (detail), size L.** The item itself says research first, then design. In 0.5.0 (detail) produce a single templates design note covering the survey, the loop model and the structure-first pass.

#### #85: template selection during document creation

**What it is.** When the user asks for a document and no default template is configured, list the templates in `templates/` for the user to pick from, apply it via `office_fill_template`, and if none exist explain how to create one; it needs a new "default template" setting (per document type). It depends on the template-creation work for the "none exist yet" guidance, though the picker could land alone.

**Recommendation (Claude): 0.5.0 (detail), size M, part of the templates design** (#197, #198, #85): one design for how a user finds, creates, chooses and defaults a template.

### P6: item details and recommendations (DECIDED 2026-10-19)

**Decided 2026-10-19 (Deepak):** #159 0.4.0; #134 0.3.2; #122, #135, #136 Parked, to be revisited after 0.5.0 (the Mistral 429 message stays noted in #135).

**Context.** The sponsor uses Anthropic and OpenAI, not Groq or Mistral. P6 is only a grouping label. Checked in the code today: `src/main/providers/anthropic.ts` has no extended-thinking code, and `vite-node` is not in `package.json`.

#### #159: Anthropic extended thinking

**What it is.** Claude can think before answering and stream that reasoning. The app already shows thinking for other providers (#147); for Anthropic it never asks for it, and ignores the `thinking_delta` events it would receive. Needed: (1) an opt-in setting that adds `thinking: { type: 'enabled', budget_tokens: N }` to the request; (2) handling `thinking_delta` events so the reasoning shows in the existing thinking block; (3) Anthropic's multi-turn rule: when tool use follows a thinking block, that block (with its signature, and any redacted block) must be sent back verbatim on the next turn, or the request is rejected; (4) the budget counts toward output tokens and cost, and thinking changes the caching of the conversation prefix. An Anthropic key is available here, so it can be verified live.

**Recommendation (Claude): 0.4.0, size M.** You asked for it as a work item. It is cloud-only and aimed at the sponsor's provider; the main risk is the replay rule (3), which must be verified live and covered by a test. Keep it opt-in, off by default, with the token budget set in Settings and cost shown.

#### #134: declare vite-node as a pinned devDependency

**What it is.** The eval scripts (`routing-eval.mts`, `cache-probe.mts`) and the commands in `docs/manual_testing.md` only work through Vite's runner, but it is not in `package.json`, so `npx` downloads whatever is current each time. Fix: add it pinned, and add `npm run eval:routing` and `eval:cache` scripts.

**Recommendation (Claude): 0.3.2, size S.** A developer-only chore with no user-visible risk; it makes later evaluation reproducible.

#### #122: slim router hot-core review

**What it is.** The slim router is experimental and off by default. Evidence from one model family says dropping `read_file` and `list_directory` from its core helps (exploring-first fell 30 to 14 of 43), but it is one sample each, so nothing was changed. Also open: a usage report in Settings, and whether the `describe_capabilities` sentence makes small models call it needlessly.

**Recommendation (Claude): Parked.** It only affects an off-by-default option. Revisit with the router work in P7 (#123 to #127).

#### #135: slim and full router on providers with hard limits (Groq, Mistral)

**What it is.** Groq rejects a whole request when the model calls a tool not in the request (10 to 12 of 43 slim cases failed); the full router does not fit Groq's free tier; Mistral's configured model gave HTTP 429 with a quota of 0 and the app shows only "429 Rate limit exceeded".

**Recommendation (Claude): Parked, with one carve-out.** The Groq parts are provider-specific and the sponsor does not use Groq. The unhelpful 429 message (say the account has no access to the model) is small and useful for any provider; I suggest we keep it as a note in the item and take it up if a real user hits it, not schedule it now.

#### #136: finish the Groq evaluation

**What it is.** Run four unrun slim cases, capture the raw Groq tool-validation error, and probe Groq's replay behaviour, on a fresh day of Groq quota (about 150K of 200K daily tokens).

**Recommendation (Claude): Parked.** It exists only to feed #135(a); no Groq user, low value now.

### P7: item details and recommendations (DECIDED 2026-10-19)

**Decided 2026-10-19 (Deepak):** all nine items go to 0.5.0 (detail) and will be revisited after 0.4.0.

**Context.** All nine items are architecture work: they change how roles delegate, what each role sees, and how tools and roles are loaded. None is a defect, and none is urgent for a cloud-model user on 0.3.1. Group A is the delegation chain (#124, #125, #127). Group B is MCP loading (#123, #205). Group C is roles and skills (#128, #132, #200). #49 stands alone.

#### Group A: delegation chain

**#124: nested delegation.** Today delegation is one level: a specialist's nested `runLoop` gets no delegate tools. Goal: let a specialist delegate, so the PowerPoint flow (`pptx_start_deck`, `pptx_add_slide`, `pptx_save_deck`, the only router-only tools) can move under Document Creator and out of the router prompt. Risks: loops and runaway cost (needs a depth limit), repeated history, and it needs evaluation with real models. **Recommendation (Claude): 0.5.0 (detail), size L.**

**#125: context scoping per hop, and the root cause of #105.** Non-isolated roles receive the whole parent conversation, so N hops resend the history N times, and nested specialist messages are saved interleaved in the parent's stream and repaired only at replay (the cause of the dangling tool_use bug #105). **Recommendation: 0.5.0 (detail), size L.** Design first; it must precede #124, because nesting multiplies the problem.

**#127: router prompt diet** (about 860 down to about 350 tokens). What remains is mostly the PowerPoint flow, blocked on #124, and rule text that cannot be validated without a model. **Recommendation: 0.5.0 (detail), size M.** Falls out of #124.

#### Group B: MCP loading

**#123: MCP Operator lazy schema loading and per-server toggles; #205: design revisit of the same problem.** Every tool of a connected MCP server is put into the MCP Operator's context with its full schema (one 144-tool server dominated the prompt). Intended design: name plus one line until first use, full schema loaded on demand; optional pinning to one server; an opt-in toggle for a server's handshake instructions. Questions: how a deferred tool is loaded, how it interacts with prompt caching (loading tools mid-turn changes the prefix), whether providers offer tool search, the threshold at which it matters. Measure with the largest real server first. **Recommendation: 0.5.0 (detail), size M-L, merge #205 into #123** (one design, one item).

#### Group C: roles and skills

**#128: skills (agentskills.io style) for roles.** Deferred: the largest roles are only about 2 to 2.6K tokens, not heavy enough to justify a skill mechanism. Advice already given: stage it, prove value with plain role files first, then a SKILL.md loader scoped to roles. **#132: user-defined role follow-ups** (a `role_create` tool with confirmation, a change event to the renderer, routing evaluation for user roles, import and sharing with hash approval). **#200: expand user-defined roles** ("concept proven; scope to design"). **Recommendation: 0.5.0 (detail), sizes L, M-L, L; one "roles and skills" design** covering what a user-defined role can do, how it is shared, and whether skills ride on it. Detail only; no building before the design.

#### #49: rolling summarization of earlier turns

Long sessions currently rely on trimming and on `search_history` to recover older content. A rolling summary would keep older turns as a short summary. Needs its own trigger policy (when, by which model, at whose cost), and care with caching and with embedding consistency. **Recommendation: 0.5.0 (detail), size L**; the existing trimming plus #170 (0.3.2) cover the worst cases meanwhile.

### P8: item details and recommendations (written 2026-10-19; awaiting Deepak)

**Context.** The sponsor runs the Windows installer, so Windows correctness and install safety matter most; the macOS build has never been run; signing is deliberately deferred (#11, 2026-10-14).

#### #131: runtime hardening and platform checks

**What it is.** Four separate things in one item: (1) a cross-process **lock for venv creation** and (2) a **single-instance lock**, because two app instances could race to create the Python environment (checked 2026-10-19: `requestSingleInstanceLock` appears nowhere in `src`, so a second launch is allowed today); (3) build the `.deb` and check its Python dependencies; (4) run the workspace runtime and `python_run` on real Windows and macOS, and test the 20,000-file artifact-scan cap on a large workspace.

**Clarification asked by Deepak 2026-10-19 ("why do we need a single-instance lock?"):** two instances *using* the same Python environment is fine; running scripts in one venv from two processes is safe. The race exists only while the venv is being *created or repaired* (first run, a Retry, or a rebuild): both instances run `python -m venv` into the same folder and pip-install into it, and the failure clean-up of one (`removeDir` of the partial venv) can delete the folder the other is still building. It needs a double launch inside that first-run window, so it is rare. Beyond the venv, two instances share one settings store and database and each streams to its own window; that mostly works but is untidy. The single-instance lock is the usual cheap way to remove the whole class (a second launch just focuses the first window); a cross-process venv lock fixes only the venv case and is more code. **Revised recommendation: 0.3.2, size S: the single-instance lock only; no separate venv lock.** **Final (Deepak, same day): too remote a corner case; #131 Parked in full.**

**Recommendation (Claude, original, superseded by the revision above): split.** **0.3.2, size M: the two locks only.** They fix a real race that a non-technical user can trigger by double-clicking the icon twice. The other parts are verification chores, not fixes: (3) is covered the next time a `.deb` is built; (4) is largely covered by the sponsor's Windows use of 0.3.1 and by #208; the large-workspace check is low value. Keep (3) and (4) noted in the item and **Park** them.

#### #208: verify the macOS build on real Apple Silicon

**What it is.** The self-contained macOS build (Python, Node, Ollama with Metal) was implemented on a Linux machine and has never been executed. The Ollama bundle is conservative (about 480 MB, keeping both Metal bundles); the build is Apple Silicon only. A manual workflow, `macos-dist.yml`, builds the `.dmg`. You planned to test the upgrade path on your Mac first.

**Recommendation (Claude): 0.3.2, size S, a verification, not a code change.** Run the workflow, install the `.dmg` on your Mac and check that scripts, embeddings and an MCP server work. Do it before shipping 0.3.2, because a macOS user would otherwise get an untested build. Any fixes found become new items.

#### #221: tests for the `aws`, `az` and `gcloud` tools

**What it is.** Today the tests only check that the tools are mutating, call the right binary and report exit codes, against a fake runner. Plan: mocked tests per CLI for typical read-only calls (for example `aws sts get-caller-identity`, `az account show`, `gcloud projects list`), covering the exact arguments, JSON parsing and the unauthenticated error; an optional live smoke test, skipped unless the CLI is installed. No mutating cloud command in any test.

**Recommendation (Claude): 0.3.2, size S.** Test-only, no risk to users, and your Developer Guide review asked for it.

#### #220: `sudo` support for `shell_execute`

**What it is.** `shell_execute` has no terminal, so `sudo` fails or hangs. A password must never pass through the model, chat history or the database. With a real pseudo-terminal (the interactive terminal pane, #210) the user types the password into the pane himself, so that holds by construction.

**Recommendation (Claude): 0.5.0 (detail), size L, designed together with #210.** A one-off password prompt would be the wrong shape.

#### #11, #63, #64, #65, #66: code signing and notarization

**What it is.** Windows Authenticode, Apple Developer enrolment, notarization credentials and wiring into CI. Decided 2026-10-14: deferred until distribution is wider than a handful of named people, because of the yearly cost and because the sponsor can click through the warning once.

**Recommendation (Claude): Parked, as decided.** One new fact to weigh: the sponsor is on Windows, where SmartScreen shows the warning on every new version. If it annoys him, #65 and #66 (Windows only) are the ones to bring forward; the Apple items can stay parked.

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
| #214 | Ollama chat provider and the bundled Ollama (final scope: embedded Ollama = embeddings only, own port; chat on the user's own Ollama) | defect + decision | 0.4.0 | S-M | The hard decision 2026-10-19: embedded Ollama only for embeddings (`nomic-embed-text`), port 11450 to 11455, never 11434; "Ollama (local)" hidden from the model selection when unavailable; Settings shows the address and install instructions. | **Decided 2026-10-19 (Deepak): 0.4.0, with #224 and #225.** |
| #224 | Embedding model digest guard for the search index | enhancement | 0.4.0 | S | Proposed by Claude; the model is pulled by name, not pinned. | **Decided 2026-10-19 (Deepak): 0.4.0.** |
| #225 | Default fallback chat model (may be cloud) when the local Ollama is unavailable | feature | 0.4.0 | M | Deepak: the fallback is necessary to avoid errors; explicit, visible choice with a warning each time it is used. | **Needed (Deepak 2026-10-19); decided 2026-10-19: 0.4.0.** |

## P2 Planner and loop reliability

| # | Item | Type | Proposed | Size | Why | Decision |
|---|---|---|---|---|---|---|
| #140 | Record why a planning reply was empty (stop reason, token count) | chore (diagnostic) | 0.3.2 (reduced scope, with #141) | S | Reduce to logging the stop reason and token count when a planning reply is empty; drop the five-repetition Ollama comparison (local-model research). | **Decided 2026-10-19 (Deepak): 0.3.2, reduced scope, with #141.** |
| #141 | Retry the planning call once when its reply is empty | defect | 0.3.2 | S | Silent loss of a compound request's split; small fix (one retry); can also affect cloud reasoning models. | **Decided 2026-10-19 (Deepak): 0.3.2.** |
| #146 | MCP-availability substitution for the single-step delegate path | defect | 0.3.2 | M | Verified in the code: the top-level model is offered the MCP Operator even when no MCP server exists. Simplest fix: do not offer it when unavailable. | **Decided 2026-10-19 (Deepak): 0.3.2, option A, MCP Operator only.** |
| #170 | Keep a compact summary (not a content-free marker) in collapseOldestToolResultsToFit | defect | 0.3.2 | S | Applying an already-decided pattern from #149; avoids silent information loss in long sessions on any model. | **Decided 2026-10-19 (Deepak): 0.3.2.** |
| #191 | Reasoning-loop breaker for local models | enhancement | 0.5.0 (detail) | M | Needs evidence first and several design choices; mainly affects local models; the sponsor uses cloud models. | **Decided 2026-10-19 (Deepak): 0.5.0 (detail); the two split-off candidates are handled with it in 0.5.0.** |
| #192 | Keep each plan step to its own job | enhancement | 0.5.0 (detail) | M | A prompt line is only a suggestion to a weak model; measure first. Design together with #191. | **Decided 2026-10-19 (Deepak): 0.5.0 (detail), with #191.** |
| #226 | After a failed plan step, point recovery at the saved handoff files and do not repeat the data query | enhancement | 0.5.0 (detail) | M | New 2026-10-19 (from #192's manual test: the same query ran three times). Wastes real database calls on any model. | **Created and decided 2026-10-19 (Deepak): 0.5.0.** |

## P3 Everyday UX and trust

| # | Item | Type | Proposed | Size | Why | Decision |
|---|---|---|---|---|---|---|
| #215 | Pinned specialist does not state its role when greeted | defect | 0.3.2 | S | A defect against documented behaviour (manual test 11.6, User Guide 05); likely to be seen when the sponsor explores the Agent picker on a small OpenAI model. | **Decided 2026-10-19 (Deepak): 0.3.2.** |
| #218 | Check Settings > Auto-approve rules (why mcp_llmwiki appears; rules for MCP, databases, APIs) | defect (investigate) | 0.3.2 (the check only; redesign is #227) | S-M | Split: the check, list refresh and safety wording are small; a per-server and per-connection rules design is large. | **Decided 2026-10-19 (Deepak): split; the check in 0.3.2, redesign as #227 in 0.5.0.** |
| #227 | Auto-approve rules redesign: rules per MCP server with exceptions, grouped by source, and per-connection rules for databases and APIs | feature | 0.5.0 (detail) | M-L | New 2026-10-19, split from #218. A design task, not a patch. | **Created and decided 2026-10-19 (Deepak): 0.5.0 (detail).** |
| #216 | Grant outside-folder access up front in Settings (Add folder...) | enhancement | 0.4.0 | S | Moved from 0.3.2: it touches the security boundary (blocked folders), so it is not a low-risk patch item. | **Decided 2026-10-19 (Deepak): 0.4.0.** |
| #193 | Agent picker opens a menu instead of cycling | enhancement | 0.3.2 | S | Small UI-only change with a clear request; makes the 12 roles easier to find. | **Decided 2026-10-19 (Deepak): 0.3.2; menu opens upward.** |
| #168 | Ollama Cloud usage shown as $0 | defect | 0.4.0 | S-M | Moved from 0.3.2: affects only Ollama Cloud users and needs plumbing through shared functions; same area as the Ollama block (#214). | **Decided 2026-10-19 (Deepak): 0.4.0, with the Ollama block.** |
| #194 | Group the session list by date (configurable) | enhancement | 0.5.0 (detail) | M | Moved from 0.4.0: cosmetic compared with search (#189, #190); first candidate to cut when 0.4.0 is over capacity. | **Decided 2026-10-19 (Deepak): 0.5.0 (detail).** |
| #189 | Search across past conversations (find a session by text) | feature | 0.4.0 | M-L | More valuable than grouping once sessions pile up; design shared with #190. | **Decided 2026-10-19 (Deepak): 0.4.0, with #190.** |
| #190 | Find within the current session (Ctrl/Cmd+F) | feature | 0.4.0 | M | Ctrl+F is expected in a chat view; share the matching code with #189. | **Decided 2026-10-19 (Deepak): 0.4.0, with #189.** |
| #230 | Confirm before deleting a session | enhancement (data-loss safeguard) | 0.3.2 | S | New 2026-10-19 (Deepak). Deleting is immediate and permanent today; a small, low-risk UI change. | **Added by Deepak 2026-10-19; bucket 0.3.2 chosen by Claude on his request.** |

## P4 Files and workspace

| # | Item | Type | Proposed | Size | Why | Decision |
|---|---|---|---|---|---|---|
| #204 | Files landing in the workspace root (122 stray PNGs from scripts) | defect | 0.3.2 (S to M) | M | Reframed 2026-10-19 after Deepak's placement policy and a code check: the sweep already exists (python_run only); remaining work is extending it, a destination table, download and export folders, and drop-by-path. | **Decided 2026-10-19 (Deepak): split; the small parts in 0.3.2, #228 and #229 in 0.4.0.** |
| #228 | One code-owned destination table for generated files; `downloads/` and `exports/` folders; a rule for generated .csv/.json/.md/.txt | enhancement | 0.4.0 | M | Reframed from my first #228 (the sweep already exists). Makes "any tool that creates a file knows where to store it" true by construction. | **Decided 2026-10-19 (Deepak): 0.4.0; downloads/, exports/, data/ for .csv/.json, documents/ for .md and .txt.** |
| #229 | Drag and drop a file into the chat: insert its full path, copy to tmp/ when needed | feature | 0.4.0 | M | New from Deepak's policy 2026-10-19; there is no drop handling today. | **Decided 2026-10-19 (Deepak): 0.4.0.** |
| #203 | Design a workspace cleanup mechanism | design | 0.5.0 (detail) | M | Design only; #204 stops the worst source first. | **Decided 2026-10-19 (Deepak): 0.5.0 (detail).** |
| #169 | grep / find_in_files content search tool | feature | 0.4.0 | M | A cross-platform content search through the workspace guard; Windows has no grep for the shell tool. | **Decided 2026-10-19 (Deepak): 0.4.0.** |

## P5 Documents

| # | Item | Type | Proposed | Size | Why | Decision |
|---|---|---|---|---|---|---|
| #196 | PDF reader (convert once, read in sections) | feature | 0.4.0 | L | Repeated request; web research keeps hitting PDFs and the sponsor uses web search. Start with a spike on the engine inside Electron. | **Decided 2026-10-19 (Deepak): as proposed.** |
| #183 | Read text from images and scanned documents (OCR) | feature | 0.5.0 (detail) | L | The leading PDF engine includes OCR, so decide after the #196 spike; privacy matters for scans such as passports. | **Decided 2026-10-19 (Deepak): as proposed.** |
| #197 | Build a deck from the user's own PowerPoint template | feature | 0.5.0 (detail) | L | One design for the whole templates family (#197, #198, #85). | **Decided 2026-10-19 (Deepak): as proposed.** |
| #198 | Template generation from an existing document, done properly | feature (research) | 0.5.0 (detail) | L | Research first, then design, together with #197 and #85. | **Decided 2026-10-19 (Deepak): as proposed.** |
| #85 | Template selection during document creation | feature | 0.5.0 (detail) | M | Depends on the templates design; needs a default-template setting. | **Decided 2026-10-19 (Deepak): as proposed.** |

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
| #131 | Runtime hardening: venv-creation lock, single-instance lock, .deb check, large-workspace cap | defect + chores | Parked | M | Split: the two locks fix a real race; the rest is parked. | **Decided 2026-10-19 (Deepak): Parked in full.** |
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
