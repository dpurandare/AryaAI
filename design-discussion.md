# Sachivji — role overhaul & lazy capability loading (design discussion)

Status: **discussion draft, revision 2 — nothing implemented.** Written
2026-09-25 from a live investigation (a session where the model answered
"List all tools available to you" with "I don't have the necessary tools"),
followed by a measured audit of what Sachivji actually sends to the LLM.

**What changed in revision 2** (after a critical review of revision 1):

- **Narrow roles first; general skills deferred.** A role's prompt is already
  lazy relative to the router. Most of the saving comes from narrow roles and
  a slim router, not from a new skill mechanism. Skills are kept, but scoped
  to where measurement shows a role is still heavy after the split (MCP,
  Document Creator, and possibly Data Access / Data Processor).
- **Developer is one role** (write code, run it, git, cloud CLIs). Revision 1
  wrongly split "writes code" from "runs it". The real problem with today's
  `coding` role is the opposite: it does much more than coding (Office
  documents, spreadsheets, media) — see section 4.1.
- **Hot-tool core at the router**, chosen from real usage data, so the most
  common actions stay one round.
- **New: cross-role handoff, out-of-scope return path and follow-up-turn
  handling** (section 5) — the cases that would have broken revision 1.
- **New: corner cases found in the existing code** (section 8).
- **New: feasibility of externalized, user-defined roles** (section 11) —
  concluded feasible, medium effort, and a natural extension of the manifest
  in step 1 of the order of work.

**What changed in revision 3** (senior-engineer review, 2026-09-25 — see
section 12):

- **Typed handoff contract** with a `status`, and artifacts **derived in code**
  rather than reported by the model (5.1).
- **Routing text vs listing text**, and role summaries as validated contracts
  with example prompts (3.2).
- **Hot-core rule tightened**: usage-backed *and* budget-safe only, with a
  token cap and usage logging; `show_media` leaves the core (3.1).
- **Skill invariants** (3.3) and **MCP containment** (3.4).
- **Step 3 (handoff + replay safety) is now an explicit prerequisite and
  release gate for step 4 (slim router)**, with four named risk gates (10).

**What changed in revision 4** (2026-09-25/26, after the Northwind chart
session):

- **Python is a prerequisite; the venv is created with the workspace** (4.3,
  rewritten): `ensureWorkspace(root)`, a runtime state machine, an onboarding
  gate, pinned base packages. Risks in section 8, open questions in section 9,
  and a parallel **Track A** in section 10 that can ship before step 1.

Goal, unchanged: **the right information reaches the LLM at the right time —
nothing more.** Prompt size is a symptom; the cause is that the current design
loads everything up front and gives every role an overloaded definition.

Token figures come from a disposable vitest harness against the real code
(`createDefaultRegistry()` + `createAgents()`, tiktoken `o200k_base`, the
estimator the app uses for non-Anthropic/Google providers). ±10%. Anything
marked *(estimate)* is a projection, not a measurement.

---

## 1. What is wrong today (measured)

### 1.1 Everything the router carries is eager

| Layer | Sent on every round | Tokens |
|---|---|---|
| Top-level system prompt | `SYSTEM_PROMPT` + delegate instructions + specialist roster | ~1,170 |
| Top-level tools | **all 43** built-in schemas (`defaultTools` = the full registry) | ~9,260 |
| Delegate tools | 8 delegate schemas | ~470 |
| MCP tools | every connected server's schemas (energy_wiki: 8 tools) | ~755 |
| **Bare total** | before the user says anything | **~10.8K** |

A delegated turn then pays a specialist's own prompt and schemas on top:

| Role | Prompt | Tools | Schemas |
|---|---|---|---|
| research | 1,004 | 8 | 1,902 |
| coding | 848 | 12 | 3,087 |
| data | 817 | 11 | 2,334 |
| terminal-devops | 232 | 5 | 556 |
| email | 255 | 2 | 306 |
| page-creator | 419 | 1 | 435 |
| distribution | 157 | 1 | 106 |
| planning | 67 | 0 | 0 |

Delegation currently makes a turn **more** expensive, not cheaper: the router
already carries every tool the specialist has.

### 1.2 Roles are overloaded, so their definitions are bloated

- **Coding** ("Reads, writes, and organizes files in the workspace to
  implement changes") is not a coding role. Of its 12 tools, only 5 are code
  or file work; 4 are Office documents, 2 are spreadsheets, 1 is media.
- **Research** also owns the external-API tools and API-connection creation.
- **Data** also owns connection creation and saved queries.
- Orphans: `mcp_create_connection` and `pptx_start_deck` / `pptx_add_slide` /
  `pptx_save_deck` belong to no role — reachable only from the top level.
- MCP tools are attached to **5 roles**, so a connected server's schemas are
  paid up to 5 times.

### 1.3 The non-lazy part is the router, then the inside of fat roles

A role's prompt is *already* lazy relative to the router: `buildOrchestratorSystemPrompt`
carries only role summaries, and a role's prompt loads only on delegation.
What is not lazy:

1. The **router** carries every tool schema and every domain procedure
   (`SYSTEM_PROMPT`), so delegation saves nothing.
2. Inside a **fat role**, everything loads together: a one-line web lookup
   pays Research's 1,004 tokens, including its paragraphs on API pagination,
   async-job polling and DuckDuckGo fallbacks.
3. Role summaries are sent **twice** at the router: once in the system-prompt
   roster (~177 tokens) and again inside each delegate tool's description.

### 1.4 `SYSTEM_PROMPT` is ~60% domain-specific

Of its ~926 tokens (rough proportions by source size):

| Topic | Share |
|---|---|
| Universal behaviour (finish every part; failed tool ≠ missing capability) | ~40% |
| PowerPoint build flow | ~25% |
| `search_history` guidance (also duplicated in the Research prompt) | ~18% |
| Connection setup (db/api/mcp) | ~13% |
| Email | ~5% |

The PowerPoint flow is in **every** call, including "what's 2+2".

### 1.5 Heavy schemas, no caching

Top offenders: `office_create_document` 827, `office_extract_template` 543,
`parse_csv` 469, `pptx_compose_slide` 435, `xlsx_write` 367, `api_call` 364
(full table in Appendix A). No prompt caching is implemented (`cache_control`
appears nowhere).

### 1.6 Real usage is concentrated

From the session DB (48 user turns, 111 tool calls — a small sample, one
developer, treat as indicative; Appendix C): `shell_execute` 37,
`db_execute_sql` 14, `xlsx_write` 8, `read_file` 6, `write_file` 6, MCP wiki
calls 8, `web_search` 4. Only **3** of 111 calls were delegations — the top
level handles almost everything itself. Any design that forces the most
common actions through a delegation hop taxes real use.

### 1.7 No single source of truth about capabilities

A role's `summary` is consumed separately by the orchestrator prompt, the
delegate descriptions, the classify prompt and the forced-mode notice, and
nothing answers "what can you do?". That gap produced the "I don't have the
necessary tools" reply — aggravated by the session's own history containing
the same false sentence, which a small model then copied.

The planner has the same problem in a worse form: the classify-and-plan
prompt (`buildClassifySystemPrompt`, orchestrator.ts) carries **hand-written
capability facts as prose** — "coding has no shell access", "code that must be
written AND run is two separate steps: coding, then terminal-devops",
"building a deck is never a plan step". Each was a real fix for a real
incident, but each is now a copy of role knowledge that will silently go
stale when roles change (revision 2 merges coding and terminal-devops into
Developer, which makes the "two separate steps" rule actively wrong).

---

## 2. Design principles

1. **Progressive disclosure.** Each layer exposes only what is needed to
   decide the next step; detail loads when that step is taken.
2. **A summary is a routing decision, not documentation.** One or two
   sentences: what it does, what it does not, where to hand off. If a role
   needs a paragraph to describe itself, it is two roles.
3. **Instructions and tools travel together.** Guidance for a tool is present
   only when the tool is.
4. **One manifest, many consumers.** Router roster, delegate descriptions,
   classify prompt, forced-mode notice and the capabilities tool are all
   generated from the same data.
5. **Enforce in code, not prose.** Budgets are tests; wire-format rules are
   invariants; anything that must not depend on a weak model remembering a
   sentence is implemented as code.
6. **Measure before adding machinery.** Add a mechanism only where a measured
   number says the simpler design is not enough.

---

## 3. Proposed architecture

```
Router (top level)   sees:  short universal prompt + role summaries + hot core
   └─ Role           sees:  its own short prompt + its own tools
        └─ Skill     (only where a role is still heavy) instructions + tools, lazy
```

### 3.1 Router

Sees only:

- a **short universal prompt** (~350 tokens target: the ~40% that is truly
  universal),
- **role summaries once** — carried in the delegate tools' descriptions only;
  the duplicate roster in the system prompt is dropped,
- the delegate tools, and
- a **hot core** of directly callable tools.

**Hot-core rule.** A tool is in the core only if it is (a) **usage-backed** —
real calls in the session DB, never "because it is easy to describe" — and
(b) **budget-safe** — the whole core stays under a token cap (~1.2K), enforced
by the prompt-budget test. The single exception is `describe_capabilities`:
new, required infrastructure, so it has no usage history yet. Everything else
earns its place with evidence.

| Tool | Tokens | Evidence |
|---|---|---|
| `shell_execute` | 104 | 37 of 111 real calls |
| `read_file` / `list_directory` / `write_file` | 66 / 61 / 166 | 6 / 3 / 6 calls |
| `web_search` | 239 | 4 calls across 3 sessions |
| `describe_capabilities` | ~100 | infrastructure exception |
| *SQL trio: `db_list_connections`, `db_introspect_schema`, `db_execute_sql`* | *256* | *14 calls across 3 sessions — **conditional**: enters only if it keeps passing both tests; open decision* |

**Explicitly not core:** `parse_csv` / `parse_json` / `parse_xml` (0 calls;
`parse_csv` alone is 469 tokens), `show_media` (0 calls in the sample — it
lives with Developer, where the chart-generation flow that needs it happens),
and the Office / presentation tools (`xlsx_write` has 8 calls but in a single
session; it stays with Data Processor unless usage spreads).

≈ 740 tokens without the SQL trio, ≈ 1,000 with it *(estimate for
`describe_capabilities`)*. A tool in the core may also belong to a role (e.g.
Developer has `shell_execute`); duplicates are fine.

**Keeping the core honest.** Log tool calls locally (tool name + session, the
same pattern as `db/classify-gate-log.ts`) and surface a small report; a tool
enters or leaves the core when the data says so. No fixed review cycle — the
token cap and the usage rule do the enforcing.

Router total *(estimate)*: ~350 prompt + ~650 delegate tools (~11 roles at
~59 tokens each, today's measured average) + ~740–1,000 core ≈ **1.8–2K**,
against ~10.8K today.

### 3.2 Roles — narrow, verb-first, honest

A role is: `id`, a `summary` (target ≤ ~30 tokens: what it does, what it does
not, where to hand off), a **short** prompt containing that role's procedures,
and its tools. Because the role is narrow, its procedures are few; because
only the router's *summary* is carried at routing time, the rest is lazy by
construction. Narrow roles are cheap at the router (~60 tokens each including
the delegate schema), which is what lets each summary be accurate.

**Routing text and listing text are different fields.** Routing ("what should
run next for this request?") and listing ("what can this assistant do?") are
related but not the same job, so the manifest keeps them apart:

- `summary` — routing. ≤ ~30 tokens: what the role does, what it does **not**,
  where it hands off. The only role text the router ever carries.
- `description` — listing. Fuller prose, shown only by `describe_capabilities`
  and Settings, never in a routing prompt. Detail goes here instead of
  bloating the summary.
- `examples` / `notExamples` — a few real prompts each that belong to the role
  and that look like they do but don't.

**A summary is a routing contract, not a friendly description**, and once the
router is slim it is the router's main evidence. So it is validated, not just
reviewed:

- *Static lint (CI, deterministic):* length cap; must state **both** a
  non-scope and a hand-off cue (a pointer to the role that does the excluded
  thing); rejects over-broad wording ("anything", "all", "everything", "any
  task", "general"); flags two roles whose summaries overlap heavily; requires ≥ 2
  examples and ≥ 1 non-example.
- *Routing evaluation (not deterministic — manual or nightly, per provider):*
  replay the examples and non-examples against real models and check the right
  role is chosen (open question 7). A lint cannot prove routing quality; it
  only stops the obvious regressions.

The same lint runs on user-defined roles at load time (section 11).

### 3.3 The skill layer — scoped, with a decision gate

A **skill** bundles a procedure (markdown) with the tools it needs, loaded on
demand via a `load_skill` tool whose description/enum is the skill index. It
is worth its complexity only where a role stays heavy after the split.

**Decision gate.** After the role split (order of work, step 2), measure each
role's prompt + schemas. Projected schema totals for the narrow roles:

| Role | Schema tokens | Skills warranted? |
|---|---|---|
| Document Creator | ~2,160 | **yes** — `office_create_document` (827) and `office_extract_template` (543) are rarely needed together |
| Data Access | ~1,800 | probably — SQL vs saved queries vs API calls are distinct workflows |
| Data Processor | ~1,690 | probably — parsing vs spreadsheets |
| Developer | ~1,320 | no — one coherent workflow |
| Configurator | ~946 | no — used rarely, and only one of three at a time; consider it |
| Researcher / History / Email / Page Creator | 178–559 | no |
| **MCP servers** | unbounded | **yes** — the case skills were really needed for |

Rule of thumb for the gate: **a role whose prompt + schemas exceed ~1.5K
tokens and split into clearly separable workflows gets skills; others stay
flat.** Roles with a single skill would auto-load it, so a role can be
migrated without a load round-trip.

**Mechanics, if built** (all constraints below come from the existing code —
section 8):

- `runLoop` builds `toolByName` / `toolDefs` once before its round loop;
  skills need the active tool set to be mutable per round.
- `load_skill(name)` returns the skill body as a **tool result** and adds its
  tools to the active set for the rest of that delegation. Each new
  delegation starts clean.
- Skill results must be **pinned**: exempt from `capRepeatedToolResults`,
  from `refitConversationToBudget`'s collapse pass and from
  `trimToolResults`' 4,000-character cap. Otherwise the procedure silently
  disappears mid-run.
- `load_skill` rounds must **not** consume the role's `maxRounds` (Email has
  4). Cap the number of skills loadable per delegation so a model cannot load
  everything "to be safe" and rebuild the eager prompt.
- The router may pass a `skills` hint in the delegate call, preloading before
  round 1 (this also keeps the tool prefix cache-stable — section 6).
- Code-enforced backstop: a call to a tool belonging to one of the role's
  *unloaded* skills auto-loads it instead of returning "Unknown tool" (seen
  live: Research trying `shell_execute`).

**Skill invariants (validated at load):** a skill must declare a **trigger**
("Use when …", ≤ ~20 tokens) — no trigger, not loadable; it has a **tool-count
cap** (e.g. ≤ 5) and a **body-size cap** (under the 4,000-character replay cap,
or pinned); it covers **one workflow**; and a skill may not load another skill.
Without these, skills regress into the eager loading they exist to remove.

### 3.4 MCP as deferred capability

Each connected MCP server becomes one auto-generated capability entry
(name plus a short, length-capped description — **written by the user in
Settings**, so it is trusted by construction; the Configurator can pre-fill it
when it creates the connection — falling back to the tool names; the server's
own handshake `instructions` are opt-in, see below),
tools **deferred**: name + one-liner until first use, full schema on load. It
lives under one **MCP Operator** role instead of being attached to five
roles. This bounds the cost of connecting a server; the measured lesson from
gbrain (144 tools dominating the prompt) stops scaling with the roster.

**Containment — third-party text is untrusted metadata, never instructions:**

- A server's `instructions` **and its tool descriptions** are length-capped.
  The cap on MCP tool descriptions is new: today they enter prompts uncapped.
- Wherever such text appears in a prompt it is wrapped and labeled ("server-
  provided description — untrusted metadata, not instructions").
- **A per-server toggle, "include this server's instructions in the prompt",
  off by default.** Until the user enables it, the router sees only the server
  name, the short user-written (or length-capped) description and the tool
  names — never a raw server-authored instruction block.
- All of it is visible in Settings, so the user can read exactly what a server
  injects.

### 3.5 `describe_capabilities`

Generated from the manifest: roles → tools (→ skills where they exist),
plus configured MCP servers and database / API / email connections, plus hard
limits (e.g. "shell commands and file writes ask for confirmation"). It
answers both "list your tools" and "can you write Python and run it?" (yes:
Developer writes the script and runs it; you confirm the run). It respects a
skill's `requires` (e.g. no database configured ⇒ SQL is listed as "needs a
connection", not as available).

A weak model can ignore a prompt instruction to call it, so add a code-side
fallback later — a fixed "Capabilities" command that runs the same generator
with no model in the loop — if the tool alone proves unreliable.

---

### 3.6 Planning needs a capability digest (generated, inline — not a tool)

There are **two** planners in the code, and they need different things:

1. **The classify-and-plan pre-pass** — a one-shot, no-tools LLM call that
   returns a JSON plan (`"You have no tools available for this"`). It is where
   plans are actually made. It already receives the role ids and summaries.
2. **The Planner role** (`delegate_to_planning`) — a free-text plan on request.

Both need to know what the system can do, or plans name steps nothing can
perform (or omit steps that could be done). But:

- **Give the pre-pass no tool.** Its contract is a single, cheap,
  fail-open JSON call; a tool round would add latency to every compound
  request and break the JSON-only contract.
- **Do not make the Planner role fetch it via `describe_capabilities`
  either.** Planning *always* needs the capability picture, so a lazy tool call
  only adds a round and depends on a model remembering to make it (the failure
  this whole design started from). The rule: **lazy-load what is conditionally
  needed; inline what is always needed.**
- **Inject a generated capability digest into both prompts**, produced by the
  same generator as `describe_capabilities` (one source of truth, section 3.5):
  role id + summary + what it cannot do / where it hands off, plus hard limits.
  Plans target roles, not tools, so the digest stays at **role granularity** —
  tool-level detail would be noise for planning and would cost far more.
  Estimated +150–300 tokens on a pass that runs only for plausibly compound
  requests (the classify gate skips simple ones).
- **The digest includes live state, not just static roles.** A correct plan
  depends on what is configured: "email it to X" is unplannable with no email
  account; "query the database" needs a connection; MCP servers come and go.
  So the digest carries, per role, the `requires` status (e.g. "Data Access: 1
  database connection — `kagent_sample`; no external APIs", "Email: no
  accounts configured"). This is where a generated digest beats hand-written
  prose most clearly.
- **Replace the hand-written role facts** in the classify prompt with digest
  content, and keep only the genuinely procedural rules ("don't
  over-decompose", "steps that need no tool belong in the final answer"). Rules
  that encode a role boundary move onto the role's own summary/limits, so they
  change when the role changes. Migration item for step 2 of the order of work:
  the "coding then terminal-devops" rule disappears with the Developer merge,
  and "deck building is never a plan step" must be re-expressed as a Document
  Creator fact (it owns presentations) or the classifier will keep planning
  around a constraint that no longer exists.

---

## 4. Proposed role catalogue

### 4.1 Where today's `coding` role's responsibilities go

`coding` today owns 12 tools across five unrelated jobs:

| Today's `coding` tool | Job | Goes to |
|---|---|---|
| `read_file`, `list_directory`, `write_file` | file/code work | **Developer** (also core) |
| `git_exec`, `git_clone_repo` | version control | **Developer** |
| `office_read_document`, `office_create_document`, `office_fill_template`, `office_extract_template` | Office documents | **Document Creator** |
| `xlsx_read`, `xlsx_write` | spreadsheets | **Data Processor** (also usable from Document Creator when the spreadsheet is the deliverable) |
| `show_media` | showing images | **Developer** (chart-generation flow; 0 real calls, so not core) |

### 4.2 Roles

Schema tokens are measured; skill instruction text is not yet written.

| Role — summary | Tools | Schema tokens |
|---|---|---|
| **Planner** — turns a complex or ambiguous request into ordered steps at role granularity; no tools of its own, but its prompt (and the classify-and-plan pre-pass) carries a generated capability digest incl. live configuration state — see 3.6. | — | 0 |
| **Researcher** — finds information on the web and reads web pages; does not recall past chats or call configured APIs. | `web_search`, `parse_html` | 559 |
| **History Analyst** — recalls and compares things from earlier conversations, including how a detail changed over time. | `search_history` | 178 |
| **Developer** — writes and edits code and files, runs commands, works with git, and uses cloud CLIs / GitHub; asks for confirmation before anything with side effects. | `read_file`, `list_directory`, `write_file`, `shell_execute`, `git_exec`, `git_clone_repo`, `aws_cli`, `azure_cli`, `gcloud_cli`, `github_cli`, `show_media` (absorbs Terminal/DevOps and Distribution) | 1,317 |
| **Data Access** — queries configured databases and calls configured external APIs. | `db_list_connections`, `db_introspect_schema`, `db_execute_sql`, `db_list_rows`, `db_count_rows`, `db_find_rows`, `db_save_query`, `db_query_*`, `api_list_connections`, `api_introspect`, `api_call`, `api_check_status` | ~1,800 |
| **Data Processor** — transforms local structured files (CSV, JSON, XML, spreadsheets); does not write general-purpose code. | `parse_csv`, `parse_json`, `parse_xml`, `xlsx_read`, `xlsx_write`, `read_file`, `list_directory` | ~1,690 |
| **Document Creator** — creates, fills from templates and reads Word/Office documents; builds presentations. | `office_create_document`, `office_fill_template`, `office_extract_template`, `office_read_document`, `pptx_start_deck`, `pptx_add_slide`, `pptx_save_deck` (delegates slides to Page Creator) | ~2,160 |
| **Page Creator** (internal, delegate-only) — designs one slide from a brief. | `pptx_compose_slide` | 435 |
| **Configurator** — sets up connections: databases, external APIs, MCP servers, email accounts. Secrets go through the confirmation dialog, never chat. | `db_create_connection`, `api_create_connection`, `mcp_create_connection` | 946 |
| **Email** — drafts and sends an email from a loose brief. | `send_email`, `list_email_connections` | 306 |
| **MCP Operator** — uses the tools of connected MCP servers. | deferred, per server | index only |
| **Media** — *deferred.* Only `show_media` exists; it stays with Developer. Create the role at ~3 media tools. | — | — |

Notes:

- **The PowerPoint flow moves out of `SYSTEM_PROMPT`** into the Document
  Creator role prompt. Zero cost unless a deck is requested.
- **The `search_history` paragraph moves into History Analyst** (it is
  currently duplicated in `SYSTEM_PROMPT` and the Research prompt).
- **Connection-setup guidance moves into Configurator.**
- Old role ids stay valid for persisted `agentRole` values: `coding` is kept
  as the id for Developer, `data` for Data Access, `terminal-devops` and
  `distribution` map onto Developer.
- A tool may belong to more than one role (xlsx above, core tools).

### 4.3 Workspace runtime (Python) — from the Northwind chart session

Found live: the workspace already had a working `venv/` and the agent still
reported "Python is not available", because nothing in the app knew the venv
existed. Hotfix #107 hard-wires it into `shell_execute` (activated in code
whenever present, plus a bootstrap hint when it is not).

**Decision (Deepak, 2026-09-25): Python is a prerequisite to run Sachivji, and
the venv is created together with the workspace and its internal folders** —
not improvised by an agent mid-task. The redesign makes the runtime a managed,
first-class part of the workspace rather than a shell trick.

**Today (verified in code).** `createToolContext()` only does `mkdirSync(root)`.
The managed folders (`code/ documents/ resources/`, plus the excluded
`templates` and `.sachiv-clones`) are created lazily on first file write, and
`WorkspaceSetRoot` only mkdirs and swaps the path guard. There is no explicit
"ensure the workspace" step, and two entry points need one (startup and
set-root). An `onboardingCompleted` setting and flow already exist and are the
natural place to extend.

**1. `ensureWorkspace(root)`.** Idempotent; creates the managed folders and the
venv; never destroys content; called from startup and from set-root. It drives
a state machine —

`missing-python | creating | ready | failed(reason) | disabled`

— shown in Settings > Runtime and in onboarding, and fed into
`describe_capabilities` and the planner digest as a `requires` state so the
router knows when code execution is unavailable. The `shell_execute` "no venv"
hint should point at this state instead of suggesting the model bootstraps one.

**2. Detection.** Try `python3`, `python`, and `py -3` (Windows) with
`--version` and a timeout. The interpreter must import both `venv` and
`ensurepip`. Minimum version to be settled (open question 9), verified against
the base packages. Platform traps are listed in section 8.

**3. Creation and packages.** `<python> -m venv <ws>/venv`, and always
`<venv python> -m pip` (never a bare `pip`). Base packages are a **curated,
pinned** list (candidates: matplotlib, numpy, pillow, python-docx, openpyxl),
installed in the background with progress, retryable and **non-fatal**; keep a
managed requirements file. Package installs requested later by an agent are a
separate, confirmed action (`pip install …` into the venv only). Existing venvs
are **adopted, not recreated**. On the reference machine `pip` inside a
workspace path containing a space works (the default workspace is
"Sachivji Workspace"), but going through `python -m pip` stays the rule.

**4. Enforcement.** "Prerequisite" can mean two things. Recommendation: an
**onboarding gate** — onboarding cannot finish until the runtime is `ready`,
unless the user explicitly chooses "continue without Python", which sets
`disabled` and makes the capability listing say code execution is unavailable.
A hard block on app start would lock out chat- and DB-only users for no
benefit. This is Deepak's call (open question 9). Installer level: the `.deb`
can declare `depends: python3, python3-venv` in `electron-builder.yml`; dmg,
AppImage and NSIS cannot, so they rely on README text plus detection (NSIS could
open the download page).

**5. Alternative, not recommended for v1.** Ship or download a private
standalone Python (python-build-standalone or uv). It removes the prerequisite
and the platform gotchas, at the cost of size, network access and macOS
notarization / Windows SmartScreen complexity. Keep it as the fallback if the
support burden of a system-Python prerequisite turns out to be high.

**6. Lifecycle.** Venvs are not relocatable, so a "Repair runtime" action
rebuilds one; changing the workspace root must ensure a fresh venv for the new
root. Other lifecycle and failure corner cases are in section 8.

**7. Tools built on it** (these land with the role work, not with the
prerequisite — see Track A in section 10):

- **`python_run`** (Developer role, not core) resolves the interpreter itself —
  never `python` vs `python3` guesswork — and runs a workspace script.
- **Reports what it produced.** It returns the files the script created or
  changed, which is exactly the `artifacts` field of the handoff contract
  (5.1) — derived in code, not claimed by the model.
- **Takes a script path or a source body, not a shell string.** D2 (Appendix D)
  showed the model sending compound Python through `python -c "…"` and pasting
  multi-line code as a shell command, ~10 failed retries in a row. Accepting the
  code as a file or a body parameter removes the quoting failure entirely.
- **Charts into Word need a route.** No Office tool embeds images today; D2's
  agent had to fake it. Either the run uses `python-docx` (needs the base
  package list to include it — it is a candidate above) or an image-capable
  Office tool is added. Decide when the Developer role is specified.
- **Write and run in one role.** Developer both writes the script and runs it,
  removing the "coding says it can't execute / a separate step never ran"
  failure by construction (a plan with a code step and no run step becomes
  impossible to express, not merely discouraged).
- **A venv is not a sandbox.** It isolates packages, not the filesystem;
  `shell_execute` and any script can still read and write anywhere the user
  can. Real confinement (a container or OS-level sandbox, or at minimum path
  confinement for scripts) is a separate, larger item and is **not** implied by
  this section. Until then the confirmation dialog remains the safety
  boundary, and the tool descriptions must keep saying "not a sandbox".

---

## 5. Cross-role behaviour (new — what revision 1 missed)

### 5.1 Multi-domain requests and handoff

"Search the web, summarize into a Word doc, email it" spans Researcher →
Document Creator → Email. Today one context handles it in one loop; with
narrow roles, data moves between specialists only as router text — lossy and
large. Proposed contract:

A **typed exchange in both directions** — a first-class contract the code
enforces, not prose the model has to interpret:

```
delegate call   (router → role):  { role, task, inputs: [artifact path | short text],
                                    context: 'isolated' | 'full' }
delegate result (role → router):  { role, status: 'done' | 'needs_input' | 'out_of_scope' | 'failed',
                                    summary, artifacts: [workspace paths],
                                    blockers?: [questions], suggestedRole? }
```

- The result carries a **summary and paths, not bulk content.** A role that
  produces a substantial result writes it to a workspace file and returns the
  path.
- **`artifacts` are derived in code:** the orchestrator records the files the
  delegate's mutating tool calls actually touched (`write_file`, `office_*`,
  `xlsx_write`, `pptx_save_deck`, …) and attaches them itself. The model's own
  account is advisory — a weak model can neither omit nor invent an artifact.
- **`status` is set in code where code can know it** (exception or round-cap
  hit ⇒ `failed`; clean end ⇒ `done`) and by the model only for the two
  judgment cases, `needs_input` and `out_of_scope`, via a short trailing tag.
  Parsing is tolerant: a model that gives no structure defaults to `done` on a
  clean end, never to a parse error.
- The router passes `inputs` (paths + short summaries), not content, into the
  next delegate's brief.
- **Context scoping per hop.** Non-isolated roles currently receive the whole
  parent conversation, so N hops resend the history N times. For pipeline
  steps default to brief + artifact paths (`isolated`), and reserve
  full-history delegation for tasks that genuinely refer back to the
  conversation. *(Open question 2.)*

### 5.2 Wrong role / out-of-scope return path

A role that receives a task outside its scope returns a structured
"out of scope — suggest: `<role>`" result instead of improvising or failing
silently. The router may redirect **once** per request (prevents ping-pong).
This is the `out_of_scope` status of the handoff contract (5.1); `needs_input`
is its counterpart when the role needs something from the user.

### 5.3 Follow-up turns

Persisted history contains tool calls for tools that are not in the current
turn's tool list (the router no longer carries them). Two effects:

- The model may copy a historic call directly and get "Unknown tool".
  Code-enforced fix: at the router, an unknown-tool error for a tool that
  **belongs to a role** returns "that tool belongs to `<role>` — call
  `delegate_to_<role>`", not a bare failure.
- Some providers may reject a `tool_use` for a tool not in the request's tool
  list. **Must be verified per provider before this ships**; if any rejects,
  replay prior-turn calls of non-active tools as compact text ("[earlier:
  called `xlsx_write` → ok]"), as a transform in `prepare-context.ts`, in the
  same spirit as `repairDanglingToolUses`.
- If skills are built, a skill's instruction body from a **previous** turn
  must not replay without its tools (instructions with no tools are worse than
  neither): strip or collapse prior-turn skill results on replay.

### 5.4 Pinned "Agent: X" mode

Narrower roles mean a user pinned to Researcher no longer has the API tools
they had under today's Research. The existing forced-mode notice already
names the right role and points at the selector; it should be generated from
the manifest so it stays accurate. Delegate-only roles (Page Creator) stay out
of the picker; with ~10 roles the Ctrl+Tab cycle needs a rethink (grouping,
or a search-style picker).

---

## 6. Other reductions (independent of roles and skills)

- **`SYSTEM_PROMPT` diet.** Keep only the universal rules; domain paragraphs
  move to the owning role's prompt; "found live: …" incident narratives move
  to `TASKS.md`, leaving one sentence of rule. Target ≤ ~350 tokens.
- **Deduplicate summaries.** Carry each role summary once (delegate tool
  description); drop the system-prompt roster.
- **Schema diet.** Audit the heaviest tools (`office_create_document`,
  `office_extract_template`, `parse_csv`, `pptx_compose_slide`, …): tighter
  descriptions, drop parameter prose that only restates the name.
- **Prompt-budget test.** Make the measurement harness permanent: a vitest
  that fails when the router prompt, any role prompt, or any single tool
  schema exceeds its budget — including the **hot-core cap (~1.2K)** and each
  role summary's length. This is what keeps the design from regressing one
  "helpful paragraph" at a time. Alongside it, local **tool-usage logging**
  (3.1) so the hot core is rebalanced from evidence.
- **Caching — with honest expectations.** Stable prefix order (system → tools
  in deterministic order → history); Anthropic `cache_control` on the
  tools+system prefix; OpenAI-compatible providers cache automatically when
  the prefix is byte-stable. Note the trade-off: on providers with strong
  caching (Anthropic, OpenAI) a large stable prefix is billed at a fraction
  after the first hit, so the **money** saved by shrinking the prompt is
  smaller than the token counts suggest, and a mid-run tool-list change (a
  skill load) breaks the cache once. The shrink matters most for
  small-context local models (a 4K window cannot hold today's prompt at all),
  for providers without strong caching (Mistral, Groq), and for **tool-
  selection quality** — models pick worse from 50 tools than from 10.

---

## 7. Projected effect *(estimate — to be verified by the budget test)*

Tokens:

| Scenario | Today | Projected |
|---|---|---|
| Bare router prompt | ~10.8K | ~1.8–2K |
| Simple question, no delegation | ~10.8K | ~1.8–2K |
| "Build me a deck" | ~10.8K + specialist | ~1.8–2K + Document Creator (~2.2K schemas, less with skills) |
| Connecting another MCP server | +N × per-tool tokens every round, up to 5× | ~1 index line until used |

LLM rounds (the cost revision 1 under-weighted):

| Request | Today | Proposed |
|---|---|---|
| Run a shell command / read or write a file / web search | 1 | 1 (hot core) |
| "Write a Python script and run it" | 1 loop (write + run) | 1 loop (both in core; or one Developer delegation) |
| Query a database | 1 | 1 if the SQL trio is core, else router → Data Access → tool |
| Build a deck | 1 loop | +1 delegation hop (+1 skill-load round if skills are used and not preloaded) |
| Three-role pipeline (search → doc → email) | 1 loop | 3 delegations + router; handoff via files |

Bottom line: the **prompt** gets much smaller for nearly every turn; the
**round count** is unchanged for the common cases only because of the hot
core, and rises for multi-domain requests.

---

## 8. Risks and corner cases

**Verified against the existing code**

- **Skill instructions can be silently collapsed.** `capRepeatedToolResults`
  keeps only the last 3 results per read-only tool and collapses older ones
  to a marker; `refitConversationToBudget` collapses the oldest read-only
  results when over budget. A skill body is a read-only tool result, so the
  loaded procedure can vanish mid-run. Skill results must be pinned.
- **`trimToolResults` cuts results at 4,000 characters (~1K tokens)** when
  history is replayed, so a skill body at the originally-proposed 1.5K tokens
  would be truncated on later turns. Bodies must stay under the cap or be
  pinned.
- **Output-token budgeting assumes the router is the worst case.**
  `resolveMaxOutputTokens` uses the router's prompt + full registry as the
  largest possible overhead, once per run. A role with loaded skills, or a
  large loaded skill body, can exceed that estimate.
- **Round caps.** Each `load_skill` costs a round; Email has `maxRounds: 4`.
- **Summaries are sent twice today** (roster + delegate descriptions).

**Design risks**

- **Weak models route and load poorly.** The failing session runs on
  `codestral-latest`, a code-tuned model that copied its own earlier refusal.
  Mitigations: hot core; single-skill auto-load; router `skills` hint; the
  auto-load and redirecting-error backstops; the existing classify-and-plan
  step for multi-step requests. **Do not remove the full registry from the
  router until routing is evaluated on several real models** (codestral,
  gpt-oss, Gemini flash-lite, Groq, an Anthropic model).
- **Models that over-load skills** rebuild the eager prompt with extra hops →
  cap loads per delegation.
- **Latency.** Extra LLM hops for delegated requests and for non-preloaded
  skills.
- **Prompt injection via MCP.** Feeding a server's handshake `instructions`
  into the router's prompt puts third-party text into the routing prompt.
  Length-cap it, treat it as data (never as instructions the router obeys),
  and show it in Settings so the user can see what a server injects.
- **Requests that match no role.** With thin summaries the router cannot
  reliably know what Sachivji *cannot* do; `describe_capabilities` helps but
  does not fully solve it.
- **Plan quality.** The classify-and-plan step routes steps using role
  summaries; vague summaries degrade plans. Narrow roles help, but the
  summaries are now load-bearing and need review.
- **Migration.** Persisted `agentRole` values, role chips in the renderer and
  the classifier all key on the current ids — keep old ids valid.
- **Discoverability.** A capability the model never selects is one the user
  never gets; role-summary wording is a first-class quality concern and needs
  an eval set, not just code review.

**Workspace runtime / Python prerequisite (section 4.3)**

- **Venvs are not relocatable.** They embed absolute paths, so moving or
  renaming the workspace, or changing the workspace root, breaks the venv
  silently (scripts fail with a confusing interpreter error). `ensureWorkspace`
  must run on set-root, and "Repair runtime" must rebuild rather than reuse.
- **System Python upgrades stale the venv.** `pyvenv.cfg`'s `home` points at
  the interpreter that created it; an OS or Homebrew upgrade can remove it.
  State detection must check that the venv's interpreter actually runs, not
  just that the folder exists.
- **Detection is platform-specific.** Debian/Ubuntu ship `venv` and `ensurepip`
  in a separate `python3-venv` package, so `python3 --version` succeeding is not
  enough. macOS `/usr/bin/python3` may be a Command Line Tools shim that pops an
  installer dialog. Windows `python` may be the Microsoft Store stub — prefer
  `py -3`. Every probe needs a timeout.
- **Never destroy an existing venv.** Users (and past agents) already have
  venvs with packages installed; adopt them. Creation happens only when the
  folder is missing, and repair is an explicit user action.
- **Concurrency.** Two app instances, or startup racing set-root, must not
  create the venv twice — needs a lock file and idempotent steps.
- **Third-party code at install time.** Base packages come from PyPI and run
  arbitrary code on install. Use a curated, pinned list (hashes later), keep a
  managed requirements file, and put user-requested installs behind
  confirmation. Installs are background, retryable and non-fatal.
- **Failure environments.** Offline, proxy, low disk space and antivirus
  false positives on freshly created executables must degrade to a visible
  `failed(reason)` state with retry, not a stuck onboarding.
- **Installer reach is uneven.** Only the `.deb` can declare
  `depends: python3, python3-venv` (electron-builder). dmg, AppImage and NSIS
  cannot, so the prerequisite is enforced by detection plus README text.
- **A venv is still not a sandbox** (see 4.3) — creating one at onboarding
  must not be presented to users as confinement.

---

## 9. Open questions

1. **Which tools are hot?** Data-driven, but the sample is small. Proposal:
   ship the core in Appendix-C order, log real tool usage going forward, and
   revise. Is the SQL trio in the core?
2. **Context per hop.** Isolated (brief + artifact paths) by default for
   pipeline steps, or full parent history by default? Isolation saves tokens
   but a role that needs earlier conversation context will miss it.
3. **Can the router load capabilities itself** (no delegation) for small,
   frequent ones? Only relevant if skills are built.
4. **Are skills user-extensible** (a workspace `skills/` directory)? Gives
   users their own procedures, but makes skill quality and the tools a skill
   may grant a product/safety question.
5. **History Analyst: role or core tool?** Cheap as a role; if it never needs
   more than `search_history`, a core tool is simpler.
6. **Where does confirmation policy live?** Today per tool; a role or skill
   could declare it (e.g. Developer: all mutating calls confirm).
7. **How is routing evaluated?** Proposal: replay real prompts from the
   session DB per provider, checking (a) correct role or core tool chosen,
   (b) no unnecessary delegation, (c) no dropped sub-task on multi-step
   requests.
8. **User-defined roles (section 11):**
   - **Decided (2026-09-25):** roles the user places in the roles folder
     themselves load **enabled by default**. Roles arriving through any future
     import/share feature are a separate case and still load disabled until
     reviewed.
   - Still open: extend-only or allow overriding a built-in id (recommended:
     extend-only in v1)? Folder location and whether Settings can point
     elsewhere? Should the same file format also carry skills?
9. **Python prerequisite (section 4.3):**
   - **Enforcement.** Onboarding gate with an explicit "continue without
     Python" escape (recommended), or hard-block app start? Chat- and
     DB-only users argue for the gate.
   - **Minimum Python version.** To be verified against the base package
     list (3.9? 3.10?).
   - **Base package list.** Candidates: matplotlib, numpy, pillow,
     python-docx, openpyxl — which are installed eagerly, which on demand?
   - **Venv location.** Visible `<ws>/venv` (today, discoverable, adopts
     existing venvs) or hidden `<ws>/.sachiv-venv` (harder for users to
     break, invisible in the file browser)?
   - **Fallback.** If the prerequisite proves a support burden, bundle or
     download a private standalone Python (python-build-standalone / uv)?

---

## 10. Suggested order of work

Each step ships on its own and is checked against measured numbers.

1. **Manifest + `describe_capabilities` + prompt-budget test.** Roles as
   data; all consumers generated from it; the measurement harness made
   permanent to record the baseline. No behaviour change. Fixes the reported
   "list your tools" failure. Design the role record so it can later be loaded
   from files (section 11) — id as a validated string, label / pickable /
   plannable on the record, agents built per run.
2. **Narrow roles + `SYSTEM_PROMPT` diet.** Split per section 4, fix the
   orphaned tools, move each domain paragraph into its role's prompt,
   deduplicate summaries. Rewrite the classify-and-plan prompt to use the
   generated capability digest (3.6) instead of hand-written role facts, so
   the plan stays correct after the role split. The router still carries the
   full registry, so this is low-risk. Measure delegated-turn cost — this is
   the **skill decision gate**.
   **Status — implemented 2026-09-26 (TASKS #113), with these deviations from the plan above:**
   - *Role set:* Planner, Researcher, History Analyst, Developer (`coding`, absorbs Terminal/DevOps and Distribution), Data Access (`data`, now also owns the external-API tools), Data Processor, Document Creator, Configurator, Page Creator, Email. **MCP Operator is not created** — MCP tools stay attached to Researcher / Developer / Data Access exactly as before (scoping them is step 5). `terminal-devops` and `distribution` survive only as labels for old sessions (`LEGACY_ROLE_LABELS`); their delegate names are renamed to `delegate_to_coding` on history replay.
   - *PowerPoint flow stays in `SYSTEM_PROMPT` and at the top level.* Moving it into Document Creator needs a specialist to delegate to Page Creator (nested delegation), which does not exist; `pptx_start_deck` / `pptx_add_slide` / `pptx_save_deck` are the only deliberately router-only tools (asserted in `roles-coverage.test.ts`). Revisit with step 3/4.
   - *Router prompt diet:* the search_history and connection-setup paragraphs moved into History Analyst / Configurator (one-line pointers remain), and the duplicated roster was dropped (each summary is carried once, in its delegate tool description).
   - *Classify prompt:* role facts are generated from the manifest (`buildRoleDigest`, with live "UNAVAILABLE right now" state); the hand-written "coding writes, terminal-devops runs" rule is **gone** and reversed — a role that writes AND runs code handles both in one step. Added a rule that a later step only sees earlier steps' written results, so an earlier step must return actual values (an interim guard for D2's fabricated data until step 3's typed artifacts).
   - *Measured:* router fixed cost is flat (10,619 → 10,563 tokens — it still carries the full registry, step 4); the saving is on delegated turns (Researcher 2,803 → 1,236, Developer 3,808 → 2,099). Largest roles now Data Access 2,513, Document Creator 2,216, Developer 2,099 — the **skill decision gate**: none is heavy enough to justify skills yet.
   - *Summaries are now validated contracts:* `lintRoutingSummary` runs on the real manifest (non-scope + named hand-off role, <= 30 words, no over-broad wording, no near-duplicates).
3. **Handoff contract + replay safety** (section 5): the typed delegate
   call/result with `status`, code-derived artifacts, the out-of-scope /
   `needs_input` return path, the redirecting unknown-tool error, and the
   per-provider history-replay verification. **A prerequisite for step 4, not
   optional cleanup.**
4. **Slim the router.** Remove the full registry, keep the hot core (3.1).
   **Release gate: do not ship until step 3 is done and the four risk gates
   below are resolved.**
5. **MCP as deferred capability** (MCP Operator role, length-capped
   instructions).
6. **Skills, only where step 2's measurement warrants** (Document Creator,
   possibly Data Access / Data Processor), with pinned results and uncounted
   load rounds.
7. **Schema diet + caching.**

**Track A — workspace runtime (parallel, independent of steps 1–7).**
`ensureWorkspace(root)` and the Python prerequisite (4.3) touch startup,
set-root, onboarding and Settings, not roles or prompts, so they can ship
before step 1 as their own release. Order inside the track:

- **A1.** `ensureWorkspace(root)` (folders + venv creation, idempotent) with the
  state machine, wired to startup and `WorkspaceSetRoot`; Settings > Runtime
  shows state, retry and "Repair runtime".
- **A2.** Onboarding gate and README / installer prerequisite text.
- **A3.** Runtime state fed into `describe_capabilities` / the planner digest
  (`requires`), so the router knows code execution is unavailable when it is.
- **A4.** `python_run` tool (Developer role) — depends on the role work in
  steps 1–2 and on the handoff contract's `artifacts` field (step 3), so it
  lands with those, not with A1–A3.

**Risk gates for step 4** — kept visible, each to be resolved and not deferred:

1. **Per-provider replay compatibility** for history containing calls to
   tools not in the current request's tool list (Anthropic, OpenAI-compatible
   incl. Mistral and Groq, Google, Ollama).
2. **Multi-model routing evaluation** — codestral, gpt-oss, Gemini flash-lite,
   Groq, an Anthropic model — using the role examples / non-examples (3.2) and
   real prompts from the session DB.
3. **Caching economics** — measure the real cost and latency effect per
   provider before claiming savings, and confirm the tool list is
   byte-stable across requests.
4. **Classify-prompt migration** — hand-written role facts replaced by the
   generated digest (3.6), verified on real compound prompts.

---

## 11. Externalized role definitions (user-added roles)

Question: can role definitions live outside the code so a user can add their
own later? **Feasible — medium effort, low architectural risk — and it fits
the design above rather than fighting it.** Findings from the code:

### 11.1 What already helps

- The runtime is mostly dynamic already. `Orchestrator` takes a
  `Map<AgentRole, Agent>`; `roleFromDelegateName` resolves a delegate call by
  map lookup; `delegateToolName` derives the tool name from the id; forced
  mode looks the role up in the map.
- Role tool sets are already read live: every `get tools()` re-reads the
  registry, precisely so MCP servers and saved-query tools appear after
  startup. A role that names tools by name or pattern (`mcp__energy_wiki__*`,
  `db_query_*`) works unchanged.
- **Confirmation is enforced per tool, not per role** (`mutates` /
  confirmation flow in `ipc/register.ts`), and the workspace guard is per
  tool. A user-defined role cannot grant itself anything the underlying tools
  don't already gate — it only selects among existing tools and shapes the
  prompt. That is the property that makes this safe enough to allow.
- Precedent for user-managed config exists: MCP servers and data connections
  are JSON under a settings key, and there is already a Settings UI pattern
  for them.

### 11.2 What blocks it today

| Blocker | Where | Effect |
|---|---|---|
| `AgentRole` is a closed string-literal union | `shared/agents.ts` (~70 references across ~10 files, mostly type annotations in `orchestrator.ts`) | A new id does not type-check |
| `AGENT_ROLE_LABELS` is a compile-time `Record<AgentRole,string>` used directly by the renderer | `ChatView.svelte`, `PrintView.svelte`, `App.svelte`, `export.ts` | Custom roles render as `undefined agent` |
| `AGENT_ROLES` (picker order, plannable set) is a constant | `ChatView.svelte`'s `MODE_CYCLE`; `VALID_STEP_ROLES` is a module-level `Set` built at import; the classify prompt filters on it | Custom roles can't be picked or planned |
| `createAgents(toolRegistry)` runs **once at module load** | `ipc/register.ts:147` | Edits need an app restart |
| `delegateToolName` maps `-`→`_` and back | `orchestrator.ts:430–437` | **Lossy**: ids `my-role` and `my_role` collide. Ids must be validated as kebab-case with no underscores |
| Persisted messages store `agentRole` ids | `shared/protocol.ts` | A deleted/renamed custom role must still render, not throw |
| Forced role unknown → `throw new Error('Unknown agent role …')` | `orchestrator.ts:680` | A session pinned to a deleted role would fail every send |

None of these is deep. The type widens to a string id; labels and the
plannable/pickable flags move onto the role record and reach the renderer
through one IPC "roster" call (plus a change event) instead of shared
constants.

### 11.3 Proposed format and location

**Markdown files with frontmatter**, one per role, in a user-editable folder
(e.g. `<userData>/roles/*.md`, optionally overridable in Settings) — chosen
over a JSON blob in settings because a role's body is prose: it should be
editable in any editor, diffable, versionable and shareable.

```markdown
---
id: sql-reporter                       # kebab-case, no underscores, unique
name: SQL Reporter                     # label for chips and the picker
summary: Runs read-only SQL against the configured databases and returns a formatted summary; does not modify data.
description: Fuller text for capability listings and Settings only — never sent to the router.
examples: ["Show last month's revenue by region", "How many orders were placed today?"]
notExamples: ["Update the customer table", "Export this to a spreadsheet"]
tools: [db_list_connections, db_introspect_schema, db_execute_sql, "db_query_*"]
maxRounds: 6                           # optional
isolated: false                        # optional: brief-only context
pickable: true                         # appears in the Agent: selector
plannable: true                        # valid classify-and-plan target
---
<the role's system prompt: its few procedures>
```

- **The built-in roles ship in the same format** (as bundled resource files or
  generated from the manifest of section 3). One loader, one validator, one
  code path — user roles are not a second-class add-on.
- The summary lint and example requirements of 3.2 apply to user roles too,
  at load time, with warnings in the Settings panel.
- The same file shape can later describe a **skill** (section 3.3), so
  externalization does not pre-commit to roles only.
- Extensibility boundary: **new tools come from MCP; new behaviours and
  procedures come from role/skill files.** A role file references existing
  tools; it never defines executable code.

### 11.4 Loading and validation

- Load per run (`readdir` + mtime check — cheap next to an LLM call) instead of
  once at startup, so edits apply to the next message with no restart. Keep
  the last-good copy if a file fails to parse.
- Validate, and surface results in a Settings "Roles" panel (built-ins
  read-only; user roles editable / disable-able; problems shown inline):
  id format and uniqueness; reserved ids (`delegate*`, built-in ids — see
  11.5); `summary` length cap; prompt size cap; tool-count cap; unknown tool
  names produce a **warning, not a failure** (an MCP server may simply be
  disconnected); a role with zero resolvable tools is flagged.
- Show each role's **token cost** in that panel ("this role adds ~60 tokens
  to every request"), because every enabled role's summary reaches the router
  on every turn. The CI budget test (section 6) cannot cover user roles, so a
  runtime warning stands in for it (e.g. above N roles or a total summary
  budget).
- Deleted / disabled role handling: forced mode falls back to Auto with a
  notice (not a thrown error); the renderer falls back to a humanized id when
  a persisted `agentRole` no longer resolves.

### 11.5 Risks specific to user-defined roles

- **Routing hijack.** A summary such as "handles all requests" steals routing
  from the built-ins, and overlapping summaries misroute. Mitigations: a
  summary cap, validation warnings for over-broad wording, and per-role
  disable. Open question below: may a user role **override** a built-in id?
  Recommendation: **no** in the first version — extend only.
- **Shared/imported role files are a supply-chain surface.** A role prompt is
  instructions the model follows, and it can name powerful tools
  (`shell_execute`). Confirmations still guard every mutating call, but a
  malicious file could still steer the model. A role the user wrote or placed
  in the folder themselves is the user's own configuration (same trust as a
  `CLAUDE.md`); anything arriving through a future import/share feature should
  load **disabled until reviewed**, ideally hash-approved so a later silent
  edit re-prompts.
- **Prompt bloat by accumulation.** Addressed by the token display and budget
  warning above.
- **Skills-as-files inherit the pinned-result and replay constraints** of
  section 8 — externalization does not change those.

### 11.6 Effort and sequencing

Roughly: widen `AgentRole` to a validated string id; move label / pickable /
plannable onto the role record; add the loader + validator; one IPC roster call
and change event; renderer reads labels from the roster; build agents per run
in `register.ts`; forced-role fallback; tests for validation, loader and
label fallback. About **10 files**, mostly mechanical, plus a Settings panel.

It should follow **step 1** (roles as data) and reuse it — do not build a
separate externalization path. A `role_create` tool on the Configurator
(matching `db_create_connection`'s confirm-dialog pattern) would let users
author a role from chat; that is a later, optional step.

**Recommended slice for a first version:** loader + validator + roster IPC +
Settings list with token cost, extend-only, roles enabled when placed in the
folder (decided), no import/share feature.

---

## 12. Review record (senior-engineer feedback, 2026-09-25)

| Point | Outcome | Where |
|---|---|---|
| Typed handoff exchange object | Adopted; added a `status` and made `artifacts` code-derived. Second review's field list maps onto the two-sided contract: `required inputs` → call `inputs`, `context mode` → call `context`, `role` echoed in the result | 5.1, 5.2 |
| Routing selection vs capability listing | Adopted as separate manifest fields (`summary` / `description`) | 3.2 |
| Summaries as tested contracts | Adopted: static lint in CI (both a non-scope **and** a hand-off cue required; "general" banned) + non-deterministic routing eval | 3.2, 11.3 |
| Hot-core drift / usage logging | Adopted as local usage logging + a token cap; **no fixed review cycle** | 3.1, 6 |
| Skill trigger + scope invariant | Adopted as load-time validation | 3.3 |
| MCP containment | Adopted; per-server instructions toggle (off by default), a cap on MCP tool descriptions, and a short **user-written** server description as the default routing text | 3.4 |
| Ordering: hardening before slim router | Agreed; step 3 is now an explicit release gate | 10 |
| "Simple parse tasks" in the hot core | Rejected on the data (0 calls); rule tightened to usage-backed + budget-safe | 3.1 |
| Open items: replay compatibility, multi-model routing eval, caching economics, classify-prompt migration | Kept visible as four named risk gates | 10 |

---

## Appendix A — per-tool schema cost (43 built-in tools)

Total ~9,260 tokens (this counting; `ctx.md` reports ~8,424 with a slightly
different serialization). Sorted descending across both columns.

| Tokens | Tool | Tokens | Tool |
|---|---|---|---|
| 827 | `office_create_document` | 166 | `write_file` |
| 543 | `office_extract_template` | 164 | `xlsx_read` |
| 469 | `parse_csv` | 149 | `db_find_rows` |
| 435 | `pptx_compose_slide` | 145 | `api_introspect` |
| 367 | `xlsx_write` | 132 | `show_media` |
| 364 | `api_call` | 131 | `pptx_add_slide` |
| 351 | `db_create_connection` | 122 | `office_read_document` |
| 320 | `parse_html` | 110 | `gcloud_cli` |
| 320 | `api_create_connection` | 106 | `github_cli` |
| 317 | `parse_json` | 105 | `aws_cli` |
| 287 | `db_save_query` | 105 | `azure_cli` |
| 277 | `office_fill_template` | 104 | `shell_execute` |
| 275 | `mcp_create_connection` | 99 | `db_execute_sql` |
| 252 | `api_check_status` | 93 | `db_list_connections` |
| 244 | `parse_xml` | 93 | `db_count_rows` |
| 239 | `web_search` | 88 | `pptx_start_deck` |
| 239 | `send_email` | 84 | `api_list_connections` |
| 189 | `git_exec` | 67 | `list_email_connections` |
| 178 | `search_history` | 66 | `read_file` |
| 173 | `git_clone_repo` | 64 | `db_introspect_schema` |
| 172 | `pptx_save_deck` | 61 | `list_directory` |
| 168 | `db_list_rows` | | |

## Appendix B — method and caveats

- Measured via a temporary vitest file (electron mocked as in
  `tools/setup.test.ts`) that built the real default registry and agents and
  counted each tool's `{name, description, inputSchema}` JSON. The file was
  deleted after the run; nothing from the harness is committed.
- The ~45,300-token "before removing gbrain + llmwiki" figure in `ctx.md`
  estimated the MCP portion from an average per-tool cost (~210 tokens),
  whereas energy_wiki measured ~94 per tool. The "76% reduction" quoted from
  that file is therefore approximate; the direction is reliable, the exact
  figure is not.
- `SYSTEM_PROMPT` topic shares are by raw source size and slightly overstate
  the smaller topics (quote/concatenation noise); read them as proportions.
- Per-provider tokenization differs (Anthropic and Google use their own
  counters); absolute numbers shift, ratios should not.
- Router and role totals in sections 3 and 7 are arithmetic over measured
  per-tool costs plus estimated prose; only the budget test (step 1) will
  give measured totals.

## Appendix C — real tool usage (session DB, 2026-09-25)

48 user turns, 111 tool calls across 5 sessions, one developer. Small sample:
use it to seed the hot core, not to finalise it.

| Calls | Tool | Sessions |
|---|---|---|
| 37 | `shell_execute` | 3 |
| 14 | `db_execute_sql` | 3 |
| 8 | `xlsx_write` | 1 |
| 6 | `read_file` | 1 |
| 6 | `write_file` | 1 |
| 5 | `mcp__energy_wiki__wiki_search` | 1 |
| 4 | `web_search` | 3 |
| 4 | `db_introspect_schema` | 3 |
| 4 | `xlsx_read` | 1 |
| 3 | `list_directory` | 2 |
| 3 | `db_list_connections` | 2 |
| 3 | `mcp__llmwiki__search` (removed server) | 1 |
| 2 | `office_create_document`, `search_history`, `parse_html`, `db_create_connection` | 1–2 |
| 1 | `git_clone_repo`, `db_save_query`, `mcp__llmwiki__list_knowledge_bases`, each `delegate_to_*` (3) | 1 |

## Appendix D — end-to-end acceptance scenarios

Real prompts that failed in production, kept as acceptance tests for the
redesign (routing evaluation, open question 7 / risk gate 2). Each lists what
"done" means — a check on the *outcome*, not on which role was chosen.

**D1 — Northwind charts in a Word document** (session 9bb34344, 2026-09-25).
Prompt: *"I need you to create a word document that shows bar charts for top 10
customers every year from the Northwind database. Plan the activities well and
make sure the document has the required bar charts."*

What went wrong (all observed): the first plan was [Data, Coding, Coding] with
no run step; the coding role said it "cannot execute code" (true for that role,
misleading to the user); the one shell call used `python` (not found) and the
agent gave up despite a working workspace venv; the top level later claimed it
cannot execute code although it can; the Data role wrote three `energy_wiki`
pages nobody asked for (every MCP tool is attached to 5 roles) and ran nine SQL
statements including three failed `CREATE VIEW`s; a real .docx was overwritten
with markdown text by `write_file` (guarded since #107).

Done means, checked mechanically:
1. A `.docx` exists in the workspace and **opens** (valid package) and contains
   **three embedded images**, one per year (1996, 1997, 1998).
2. The chart data matches a fresh query of the database (not transcribed
   numbers that could drift).
3. The script was **actually executed** by the system (a recorded run with exit
   code 0), and its outputs are listed as artifacts of that step.
4. **No unrequested side effects**: no wiki pages, no database views created.
5. No step reports success on the strength of "I wrote a script that would…".
6. A user asking "can you run Python?" gets **yes**, with the workspace venv
   named — from `describe_capabilities`, not from the model's memory.

**D2 — Northwind column charts in a Word file, second attempt** (session
9a7fdb57, 2026-09-26, run **after** the #107 venv hard-wiring was live).
Prompt: *"We need to find top 10 customers for each year and create column
charts for each year. I am referring to Northwind database. We want these
charts to be added to a Word file and saved. Plan the activities before
executing."* Follow-up after the first turn: *"You can execute Python code. Run
the scripts and complete the task."*

What went wrong (all observed in the transcript):

1. **The venv was used; the failure is behavioural.** `python` and `python3`
   both resolved to `<workspace>/venv` (a matplotlib traceback shows
   `venv/lib/python3.12/site-packages`), so #107 does what it was built to do.
   Making the venv available did not make the agent *use it well*.
2. **Turn 1 again produced no execution.** Plan [Data, Coding, Coding,
   Distribution]; the coding role said "I cannot execute code directly", pasted
   scripts into chat, and the Distribution step told the user to run them.
   No script file was written, nothing was run. Same failure as D1 — the plan
   still has no run step and the coding role's "no shell" disclaimer leaks to
   the user.
3. **The real data was dropped at the handoff.** The Data step returned 30 real
   rows (1996–1998). The Coding step received only the Data step's prose
   summary, wrote *"Sample data structure assumed"*, and invented
   `Customer A … Customer J` for years **2020/2021** — Northwind has no such
   years. Every chart produced is fabricated. This is the failure the typed
   handoff (5.1) exists to prevent: rows must travel as an artifact, not be
   re-typed from a summary.
4. **Shell misuse, repeated ten times.** After "you can execute Python", the
   router sent Python as `python -c "…; with …; for …"` one-liners (invalid
   syntax: compound statements cannot follow `;`), then pasted multi-line
   Python directly as the shell command (`/bin/sh: import: not found`). It
   retried near-identical variants ~10 times without ever writing a `.py` file.
   This is the repetition shape of #86 in a new tool; a `python_run` that takes
   a script path or source body (4.3) removes the shell-quoting failure mode.
5. **No tool can embed an image in a `.docx`.** `office_create_document`
   takes headings and paragraphs only, so even a correct run had no way to put
   the charts in the document. The agent then called `office_fill_template`
   with `{"charts": []}` (a no-op), and zipped the loose PNGs and the chart-less
   `.docx` into a package. The only real path today is `python-docx` in a
   script — which is why the run tool matters — or a new image-capable Office
   tool.
6. **It reported success on a chart-less result.** The final message said "The
   task has been successfully completed!", hid the gap in item 3 of its own
   list ("charts were not added … let me know"), and offered the zip as the
   deliverable.

Done means, in addition to D1's checks:
1. Chart data is **read from the query result artifact** (or re-queried in the
   script), never typed by the model; a check compares a chart's values to a
   fresh query.
2. When the user says "run it" (or the plan has a code step), the script is
   written to a file and executed by `python_run`; a shell one-liner of
   compound Python is not an accepted way to do it.
3. The `.docx` contains the charts as embedded images — via `python-docx` in the
   run, or an image-capable Office tool. Verified by opening the package.
4. A step that produced no chart in the document **cannot** report `status:
   done`; the handoff contract's status comes from code-derived artifacts
   (5.1), not from the model's closing sentence.
5. A repeated identical failure (same tool, same error class, ≥3 times) stops
   and reports rather than looping.
