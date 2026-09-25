# Change Feedback

## Overall take

This is a strong and necessary design direction for Sachivji.

The key insight is correct: the current architecture is suffering from eager capability loading rather than a lack of model intelligence. The router is carrying too much information up front, and the role system is too broad to stay cheap, predictable, and trustworthy. The proposal fixes the root cause instead of layering more prompt text on top of it.

The project already tells a clear story: this is a local-first, multi-agent desktop assistant with a strong emphasis on tool use, human confirmation, and role-based delegation. In that context, prompt bloat is not just a quality issue; it is a product issue. It affects routing quality, latency, tool selection, context limits, and the user’s perception of whether the app is “actually capable” or just “verbosely claiming to be.”

---

## What the design gets right

### 1. It targets the actual failure mode

The most compelling part of the proposal is that it treats the problem as architectural, not stylistic.

The design discussion shows the real issue clearly:

- the top-level router is carrying all tools, all at once;
- roles are overloaded and semantically muddy;
- a lot of instructions are duplicated across system prompts, role prompts, and tool descriptions;
- the app pays the cost of the full capability set even for trivial requests.

That matches the actual behavior of the app described in the README: Sachivji is a multi-agent orchestrator with many tools and a broad set of capabilities. In that environment, a single large prompt becomes the semantic equivalent of a giant registry. The fix is to emit only the minimal capability surface needed for the next decision.

### 2. The “hot core” concept is the right first principle

The proposal’s distinction between router-visible hot-core tools and role-specific lazy tools is practical and grounded. It matches real product usage better than a “just delegate more” strategy.

For an app like this, a few everyday actions should always be available directly:

- shell execution;
- file read/write/list;
- web search;
- capability introspection;
- simple local content read/parse tasks.

This is the right balance for general utility without forcing every request through a specialized sub-agent. It reduces prompt size without making the system feel artificially limited.

### 3. Narrow roles are more honest than broad ones

The discussion is persuasive on the `coding` role problem. The current model loads a single role whose definition spans five unrelated jobs: file work, git, office docs, spreadsheets, and media. That is precisely the kind of “one bucket for everything” design that leads to role confusion and oversized prompts.

Splitting this into:

- Developer;
- Data Access;
- Data Processor;
- Document Creator;
- Page Creator;
- History Analyst;
- Researcher;
- Configurator;
- Email;
- MCP Operator;

is a far cleaner model. It also aligns with the actual product story in the README: the app is not one generic assistant; it is a specialist orchestration system with distinct domains.

### 4. The prompt budget discussion is very healthy

The design does something important: it converts a fuzzy feeling (“this prompt is too big”) into measurable constraints.

This is valuable because prompt bloat is easy to ignore in a codebase that keeps adding “helpful” instructions. A design that introduces explicit metrics, stable manifests, and budget tests makes the architecture resilient to drift.

This should be treated as a product-quality practice, not only a backend optimization.

---

## What I would strengthen further

### 1. Make the handoff contract more explicit than a recommendation

The design’s artifact-based handoff pattern is a very good idea, especially for multi-role flows like:

- search → document → email;
- research → data → presentation;
- web lookup → code fix → verification.

But this should be treated as a first-class contract, not just a design suggestion.

I would explicitly define a standard exchange object for delegated work, for example:

- role;
- task summary;
- required inputs;
- produced artifacts;
- follow-up questions or blockers;
- whether context is full or isolated.

That gives the router and sub-agents a shared, predictable interpretation of what has happened, instead of relying on a model to infer “the important part” from raw chat text.

### 2. Distinguish “route selection” from “capability listing”

The proposal mentions `describe_capabilities`, which is a good idea. But I think the app needs two separate mechanisms:

- capability listing: “what can this assistant do?”
- routing selection: “what should run next for this request?”

Those are related but not identical. A model can route well even when it does not fully understand the entire capability universe. Conversely, a model that can list capabilities may still make poor routing decisions if the summaries are vague.

The proposal already knows this; it just needs to build it into the manifest contract and validation rules so summary wording becomes an operational concern, not just a prompt-writing concern.

### 3. Treat role summaries as real product contracts

This is worth emphasizing: the role summary is not a friendly description; it is a routing boundary.

Once the prompt is slimmed, the summary becomes much more important because it is the main data the router uses to decide which role to pick. That means role descriptions must be:

- short;
- clear on scope;
- clear on non-scope;
- stable over time;
- backed by tests.

If the summary says “can help with anything related to files,” the system will still route poorly. The design is right to make this a load-bearing requirement rather than a prose note.

---

## Key risks and caveats

### 1. The hot-core model should be validated against real usage, not just a small sample

The design uses a relatively small set of real call data, which is good, but the conclusion is still sensitive to the dataset. In a tool-heavy app, a hot core can drift quickly as user workflows evolve.

I would keep the core data-driven but add:

- logging of real tool selection frequency by request type;
- a review cycle that rebalances the core quarterly;
- a rule that no tool becomes “hot” simply because it is easy to describe.

This is exactly the kind of product metric that should be monitored rather than decided once in a design doc.

### 2. Skills are useful, but they are easy to misuse

The proposed skill mechanism is sensible, but it also introduces hidden complexity. The design already notes the key hazards:

- results can disappear when conversation replay happens;
- loaded skill bodies can be trimmed by budget logic;
- skills can increase round count;
- a weak model may load too many skills “just in case.”

This is valid and worth taking seriously.

I would strongly support the design’s “pin skill results and cap load rounds” idea, but I would also add an explicit invariant: a skill must have a clear trigger condition and a strict maximum scope. Otherwise, the system will regress into the same problem it is trying to solve: the app loads too much context too early.

### 3. MCP guidance needs stronger containment

The design correctly flags the risk of prompt injection from connected MCP servers. That is absolutely real.

The right direction is: treat MCP handshake instructions as data, not operational instructions.

I would go one step further and say that third-party tool metadata should always be:

- length-capped;
- explicitly labeled as metadata for the user, not instructions to the model;
- visible in Settings for review;
- subject to a trust boundary.

This is especially important in a desktop app where the user may connect a variety of local and remote tools.

### 4. User-defined roles are promising but should be tightly bounded

The externalized role design is compelling and quite feasible. It also aligns with the architecture: roles are already represented as data, and the app is dynamic enough to support a manifest-driven path.

But the risk is not the file format. The risk is that a user-defined role can create a routing hijack or broaden its scope beyond the model’s intent.

The guardrails proposed in the design are appropriate:

- extend-only in v1;
- validation of id, summary, and tool references;
- token/cost warnings;
- disabled-by-default import/share flows;
- safe fallback when a role is removed.

I would keep this feature deliberately conservative. It is valuable, but it should be a controlled extension mechanism rather than a free-form agent customization surface.

---

## Recommended direction

### Phase 1: structural cleanup first

I agree with the order of work in the discussion. The correct first move is to establish a manifest-based model where:

- role definitions are data;
- role summaries are generated from one source of truth;
- tool budgets are measured;
- the router can answer “what can you do?” without depending on the model’s memory.

This should happen before any large behavior change. It reduces risk and immediately improves the app’s reliability.

### Phase 2: narrow roles and hot core

Then do the role split and the router slimming. That is the core transformation.

This is where the app becomes materially better: smaller prompts, more accurate routing, clearer role behavior, and lower failure susceptibility when a model is weak or overloaded.

### Phase 3: explicit handoff and safety checks

Only after that should the app harden the cross-role contract and the replay logic. This is the moment to formalize artifact passing, context scoping, and unknown-tool redirection.

Sanity-check this at the code level, because without it, narrower roles can still create awkward multi-hop confusion.

### Phase 4: optional skill/mcp/user-role expansion

Skills, MCP deferred loading, and custom roles are all extensions that should be introduced only after the base architecture is healthy. These features are valuable, but they multiply complexity and should be measured carefully against the same costs the proposal is trying to remove.

---

## Final verdict

I think this is the right design reset for Sachivji.

The proposal is strong because it does not try to “fix” prompt length with more wording. It addresses the actual design issue: the system is currently loading too much capability too early. The changes proposed here make the system more honest, more measurable, more modular, and more resilient to real-world tool and model variability.

My main advice is to keep the design disciplined:

- keep the role summaries strict and measurable;
- preserve the hot-core principle;
- make handoff contracts explicit;
- enforce budget tests and tool-load constraints as code invariants;
- treat MCP and user roles as capability surfaces with trust boundaries, not as generic “anything goes” expansion.

If those are enforced, this design should improve quality without sacrificing the broad capability model that makes Sachivji compelling in the first place.
