# 4. Orchestrator and agents

The orchestrator (`src/main/agents/orchestrator.ts`, about 3,100 lines) is the heart of the app. This page describes its structure, the role system around it, and the safeguards in code. Many behaviours were added after a failure was found live; the file's comments record each one with its reason and TASKS number, and `docs/design-discussion.md` holds the design.

## The model

- A **role** (`Agent`) has a `role` id, a one-line `summary`, a `systemPrompt`, a `tools` list, and optional flags: `isolated` (brief-only context), `maxRounds`, `completionGate`, and `custom`/`label`/`pickable`/`plannable`/`meta` for user-defined roles.
- The **orchestrator** owns the conversation. It can act directly with its own tools (the "router" tool list) or **delegate** a step to a specialist. Delegation is an ordinary tool call, `delegate_to_<role>`, so it reuses the same tool-call loop, streaming, confirmation and limits at every level. Specialists do not get delegate tools, so recursion is exactly one level deep.
- Work is **sequential**: no concurrent agents.

## Roles

Built-in roles are defined in two places that must agree:

- **`src/shared/agents.ts` (`ROLE_MANIFEST`)**: the facts that cross the IPC boundary and feed routing: `id`, `label`, `summary` (what it does and **does not** do, naming the role that takes the excluded work), `description`, `examples`, `notExamples`, `pickable`, `plannable`, and `requiresAnyOf` (a configuration the role needs).
- **`src/main/agents/roles.ts` (`createAgents`)**: the behaviour: each role's `systemPrompt` and its `tools` (a live getter that picks named tools from the registry, so later-registered tools such as MCP tools appear).

`createAgents` also does three things to every working specialist: appends a completeness note and the **handoff tag** instruction, adds the `get_environment` tool and a short environment note, and merges **user-defined roles** after the built-ins.

User-defined roles (`src/main/roles`, `src/shared/role-file.ts`, `role-lint.ts`) are Markdown files with frontmatter. `validateRoleFile` returns structural problems as errors (the role is not loaded) and routing-quality problems as warnings (it loads). Loading is per turn and keeps the last working version of a file whose latest edit is broken. A role only selects tools (by exact name or `prefix*`) and supplies a prompt; confirmation and the workspace guard are enforced per tool, so a role cannot grant itself anything. See the user-facing page [Your own roles](../user-guide/06-your-own-roles.md).

## One turn through the orchestrator (`run`)

`run(conversation, forcedRole)` is an async generator that yields `OrchestratorEvent`s: `{ kind: 'stream', event }` for the UI and `{ kind: 'message', role, content }` for persistence.

1. **Budgets.** A shared `RunState` holds rounds used, token totals, the per-round output ceiling (`resolveMaxOutputTokens`, a clamp to the model's real maximum scaled by free context) and a turn deadline.
2. **Pinned role.** If the user pinned a specialist, that role runs **alone** with its own tools. A pin that no longer resolves falls back to Auto with a notice. A pinned role that answers with an `out_of_scope` handoff tag *before doing any work* hands the request back to the orchestrator.
3. **Classify and plan** (when planning is enabled). A deterministic **gate** (`classify-gate.ts`) skips the classifier call only for an unambiguous, short, single-clause message, and is occasionally overridden for calibration logging. Otherwise `classifyAndPlan` asks the model for a plan, using **provider-enforced structured output** (`StructuredOutputRequest`) with a remembered fallback to a prompt-only request when a provider rejects it; `parsePlan` is deliberately tolerant. A plan has at most 5 steps, each assigned to a plannable role.
4. **Execute.** No plan, or a single step: the **orchestrator round loop** (`runLoop`) runs with the router tools plus the delegate tools. A multi-step plan: `executePlan` dispatches each step to its specialist in order (`dispatchDelegate`), emits `plan`, `plan_step_start` and `plan_step_done`, persists each step's result as a `[Plan step N — Role]: …` message, then lets the orchestrator write the final answer.

`classifyAndPlan` also inserts a **domain-knowledge step** (look it up in a connected MCP server first) when the planner flags it and the topic is not the user's own data (`domain-topic.ts`), substitutes the MCP Operator when none is connected, and follows up an incomplete step.

## The round loop (`runLoop`)

One loop serves the orchestrator, a pinned specialist and every delegate. Each round:

1. Applies pending **steering notes** (top level only) as `user_note` messages.
2. Emits a status line, calls the provider's `stream()`, accumulates text, thinking and tool calls, and yields tagged events (`tagEvent` stamps the `agentRole` so the UI can label the part).
3. If the model made tool calls: runs each through `dispatchTool`, appends the results as a `user` message of `tool_result` blocks, and loops. If it made none, the loop ends (subject to the safeguards below).

`dispatchTool` is where safety lives, in this order: external-folder access (`askExternalAccess` for tools that declare `externalPaths`), a redirect if the tool belongs to another role, then, for a mutating tool, `confirmOrAbort` (the confirmation round trip; a denial becomes a "[Rejected by user]" tool result and an edited input replaces the original), then `executeWithTimeout`. A `show_media` payload is split into a real `image` block (never sent back to the model) and a short result text.

## Delegation and the typed handoff (`dispatchDelegate`, `handoff.ts`)

A delegate runs `runLoop` with its own system prompt and tools in a **nested state**: a fresh round budget per call (a plan's steps cannot starve each other), but the same turn deadline, and token cost that rolls up into the parent's totals. `isolated` roles see only the brief; others see the whole conversation plus the brief.

Prose is a lossy channel between specialists, and what a specialist *says* it produced is not evidence, so the contract is enforced in code:

- **Artifacts are derived, not claimed:** the workspace is snapshotted before and after a (non-isolated, tool-holding) delegate, and the files created or changed become the step's `artifacts`.
- **Data is captured:** results of data-producing tools are saved to handoff files and supplied to later steps as typed inputs, so a charting step sees the real rows, not a summary.
- **Status is decided by code:** a failed run is `failed`; the model may only choose the judgment cases through a `[handoff: …]` tag (for example `out_of_scope -> <role>`). One redirect per turn follows an `out_of_scope` tag to the role it names, if that role is plannable.
- A plan-dispatched step gets a note that the other steps belong to other specialists.

## Safeguards in code

These exist because weaker or local models ignore prompt rules. Each is tested and each has a comment with the failure that motivated it.

| Safeguard | Where | What it does |
|---|---|---|
| Round, round-timeout and turn limits | `MAX_TOTAL_ROUNDS` (30), `ROUND_TIMEOUT_MS`, `TURN_DEADLINE_MS` (15 min) | Hitting a limit asks the user (`confirmContinue`) whether to continue or stop. |
| Tool timeout | `TOOL_EXECUTE_TIMEOUT_MS` | Bounds the wait on a tool; a `cancellable` tool actually stops on `signal`. |
| Failure streak breaker | `MAX_CONSECUTIVE_TOOL_FAILURES` | Stops a run that repeats failing calls to the same tool. |
| Identical-call breaker | `MAX_IDENTICAL_CALLS_*` | A successful but identical repeat gets one nudge (which can point at the right specialist), then a hard stop. |
| Empty-response recovery | `MAX_EMPTY_RESPONSE_RETRIES`, nudges | Re-asks a round that returned nothing; a different nudge when it only held reasoning. |
| Truncated tool call recovery | `MAX_TRUNCATED_TOOL_CALL_RETRIES` | Retries a round cut off mid tool call. |
| Completion gate | `Agent.completionGate` | A role-specific check when a run is about to end (for example a research pass that read no pages) sends it back to work, a bounded number of times. |
| Restatement guard | `restatement.ts` | Drops the router's final text when it only repeats what a delegate already showed. |
| Knowledge-first gate | `knowledge-first.ts` | Holds back the first open-web lookup of a turn once when a knowledge MCP server is connected. |
| Rate-limit handling | `handleRateLimitError` | Waits and retries within bounds. |
| Tool-result trimming | `capRepeatedToolResults`, `collapseDuplicateToolResults`, `collapseOldestToolResultsToFit` | Keeps the conversation inside the context budget within a turn. |
| Previous-answer extraction | `previous-answer.ts` | Finds "the answer before this request" for `fromPreviousAnswer`, ignoring plan-step plumbing. |

## The router's tools

The orchestrator's own tool list is built per turn in `runChat`:

- **Full router (default):** `fullRouterTools(registry)`: every registered tool. This is why in Auto mode the main assistant can use any specialist's tool directly.
- **Slim router (experimental, off by default):** `selectRouterTools` keeps only a small usage-backed core (`router-tools.ts`) and reaches everything else through delegates. A budget test enforces its token ceiling. History containing calls to tools not in the list is collapsed for providers that reject such replays.

## The system prompt and capabilities

`system-prompt.ts` holds the router prompt, in its own module so the prompt-budget test (`prompt-budget.test.ts`) can measure it without Electron. Prompt text has a **token ceiling per role and for the router**, enforced by that test: adding words has a cost, and a failing budget test is a prompt for deleting something.

`capabilities.ts` builds the `describe_capabilities` tool (what the assistant can do, which roles are usable now given the configured connections, via `requiresAnyOf` and live counts) and the role digest for the classifier prompt.

## Context preparation (`context/prepare-context.ts`)

Before a turn, `prepareConversation` trims oversized tool results and drops the oldest turns to fit the model's context window, working only on what is **sent**. The window comes from `resolveContextWindow`: a live reading when the provider can give one (Ollama's `loadedContextWindow`), else the configured one (`configuredContextWindow`), else the static table in `shared/model-metadata.ts`. The result also carries the dropped turns so the UI can say so.

## Testing the orchestrator

`orchestrator.test.ts` drives the real orchestrator with a **scripted mock provider** (`test/support/mock-provider.ts`): each round returns canned events, so tool loops, confirmations, plans, handoffs, gates and limits are all tested without a model. `routing-eval.ts` and the scripts in `scripts/` measure routing against real models (see [Testing](10-testing.md) when written).
