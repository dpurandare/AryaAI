# Automatic LLM model selection

Written 2026-10-19 from a question by Deepak: how easy or difficult would it be to implement automatic LLM model selection based on parameters such as the type of input, the complexity of the operation, the nuance of the operation or information, the availability of information, the clarity of the prompt and instructions, and so on?

This is an assessment based on reading how the code handles models today. It is **not** based on a prototype, and nothing in it has been built or measured.

## Verdict

It depends on which version is meant. A **role-based version is fairly easy**, with a few real gotchas. A **fully automatic version** that scores prompt clarity, nuance and information availability is **hard**, and the advice is against building it.

## Where the code stands today

- **One model per turn.** `runChat` (`src/main/ipc/register.ts`) resolves a single provider and model from settings (`activeProviderId` and `model:<provider>`). The `Orchestrator` (`src/main/agents/orchestrator.ts`) takes them as constructor arguments, and everything runs on that one model: the planner, the router, every specialist and every delegate.
- **Pieces a selector could use:**
  - The classify-and-plan step is already a model call with structured output.
  - Plans are split into steps, each assigned to a role.
  - `describe_capabilities` already knows what is configured.
  - Usage is reported per round, and the cost and context-window tables exist in `src/shared/model-metadata.ts`.
  - The paced-provider wrapper (`agents/paced-provider.ts`) already handles rate limits.
  - Real failure signals already exist: the completion gates, the failure and repeat breakers, and empty or cut-off replies.
  - The routing-eval and plan-probe scripts already measure how reliably a model follows the app's prompts.

## Three levels of effort

| Level | What it is | Effort |
|---|---|---|
| 1. Model per role | A setting that says which provider and model each role uses, for example a cheap model for Email and a strong one for the Researcher's synthesis. | **Easy to moderate**, a few days. Give `Agent` an optional model, build the provider in `dispatchDelegate`, add a Settings control, and do the accounting. |
| 2. Tier per plan step | The planner adds a `light`, `standard` or `strong` tier to each step, and the user's policy maps tiers to concrete models. Escalate to a stronger model when the existing safeguards trip. | **Moderate**, one to two weeks, mostly spent on evaluation. |
| 3. Fully automatic scoring | Scoring input type, complexity, nuance, availability of information and prompt clarity, then picking a model. | **Hard**, and the outcome is uncertain. |

## Why level 3 is the wrong target

- **Fuzzy signals.** "Nuance" and "clarity" have no reliable measure without labelled data, and a wrong guess silently sends a hard task to a weak model.
- **Clarity is better handled differently.** An unclear prompt should trigger a question to the user, not a model switch.
- **The role already carries most of the signal.** A domain-specific role such as Data Access or Email already says what kind of work it is, and routing by role captures most of the benefit.

## Real gotchas, even for level 1

1. **Mixed models in one conversation.** History holds provider-specific details. Gemini's `thoughtSignature` on tool calls, thinking blocks and tool-call id formats do not carry cleanly across providers, so history sent to a different provider needs sanitising.
2. **Context windows differ.** `prepareConversation` trims per model, so each delegate must trim for its own model.
3. **Prompt caching breaks on a switch.** Anthropic's cache needs a stable prefix and the same model, so jumping models loses the saving.
4. **Weak models fail at tool calls.** Local models like qwen 9B can loop or ignore instructions. A cheap tier can cost more in retries than it saves.
5. **Privacy.** If data should stay local, an automatic selector must never send it to a cloud model. That rule must be enforced in code, not by the selector's judgment.
6. **Availability.** Keys exist only for some providers, so the selector must choose among what is configured.
7. **Debuggability.** Every answer needs a visible note saying which model produced it. Something similar exists already (TASKS #180).
8. **Evaluation.** There is no way to know a policy is good without a test set, and building one is most of the work.

## Recommendation

1. Build **level 1**, off by default, as an experiment.
2. Add **escalation** by reusing the safeguards that already exist: if a cheap model trips a gate, a breaker or an empty reply, retry that step on the stronger model.
3. Measure on real tasks, using the routing-eval approach, before adding the planner tiers.
4. Skip automatic scoring of nuance and clarity.

## Is it worth it?

The main wins are cost and speed. On a CPU-only local model, a round can take over a minute, so sending only the hard steps to a strong model helps. The benefit is largest for users who have both local and cloud models, and smaller for someone using one provider.

## Next steps offered, not started

- A short design note, or a file-by-file sketch of the level-1 changes (Deepak asked on 2026-10-19 that this assessment not be recorded in `TASKS.md`, so it lives only in this document).
