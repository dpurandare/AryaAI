# 10. Testing

There are three layers: fast automated tests with mocked models (the bulk), scripts that measure real models, and a manual test plan for what only a human on a real machine can judge.

## Automated tests (Vitest)

- `npm test` runs the whole suite (about 125 test files, about 1,650 tests, a few seconds). **No test calls a real API.** `npm run typecheck` and `npm run build` complete the pre-commit checks.
- Config: `vitest.config.ts` (Node environment, the `@shared` alias, and a setup file). Test files sit next to the code as `*.test.ts`. Run one with `npx vitest run <path>`.
- The setup file `test/support/no-docx-framing.ts` switches the Word "title, opening and closing section" rule off for all tests (many tests only need a sample `.docx`); `office-docs/create.test.ts` turns it back on to test the rule itself.

### The mock provider (`test/support/mock-provider.ts`)

The orchestrator and everything above providers is tested against a **scripted mock provider**: each round is a `ScriptedTurn` returning canned output, which makes loops, plans and failures deterministic. A turn can have `text`, `thinking`, `toolCalls` (with ids, inputs, a raw malformed input, a thought signature), a `stopReason`, `usage`, and failure modes that copy what real SDKs do: `throwError`, `throwStatus`, `throwRateLimit` (with `Retry-After` headers), `hang` (stalls until aborted, then **throws**, as the Anthropic and Google SDKs do) and `hangSilently` (stalls, then ends the stream **silently**, as the `openai` SDK does). Both abort shapes exist because the orchestrator has to handle both.

### What is tested how

| Area | Approach |
|---|---|
| Orchestrator (`orchestrator.test.ts`, `handoff`, `classify-gate`, `restatement`, `knowledge-first`, …) | Scripted mock provider; assert on the events emitted and the messages persisted. |
| Providers | A mocked SDK; assert on the request built and the events produced (caching markers, temperature retry, tool-call parsing). |
| Tools | Direct `tool.execute(input, ctx)` against a temporary workspace (`mkdtemp`), a real `WorkspaceGuard`, and fakes for databases, network and CLIs; refusals tested as well as success. |
| Cloud CLI tools (`tools/cloud-cli.test.ts`) | Mocked `execFile`: exact argv for typical read-only calls (`aws sts get-caller-identity`, `az group list`, `gcloud projects list`, …), JSON output returned intact, the unauthenticated error path, no shell. An opt-in live smoke test, `cloud-cli.live.test.ts`, is skipped unless `SACHIV_LIVE_CLOUD_CLI=1` and the CLI is installed and logged in; it runs read-only commands only. |
| Settings, stores, db | In-memory or temporary databases; the keychain is mocked. |
| Electron-dependent modules (`export.ts`, `tools/setup.ts`) | `vi.mock('electron', …)`, `vi.mock` of `node:fs/promises` where needed. A module that imports `electron` at the top cannot be imported by a test without a mock. |
| Runtimes | A fake filesystem and a scripted process runner (`RuntimeDeps`) on both platforms. |
| Renderer helpers (`markdown`, `theme`, `context-meter`, …) | Plain unit tests; components themselves are checked in a running app. |
| Documentation tooling (`scripts/export-docs.test.ts`) | Unit tests of the pure functions. |

### Budget and structure tests that guard design rules

- `agents/prompt-budget.test.ts`: token ceilings for the router prompt, tool definitions and each role; fails on growth **and** on a large shrink (so a saving cannot regress). See [Tools](06-tools.md).
- `agents/roles-coverage.test.ts`: every registered tool is owned by a role, except the deliberate ones.
- `agents/roles.test.ts`, `role-file.test.ts`, `role-lint.test.ts`: manifest and role-file rules, including the routing-summary lint.

When you fix a bug found live, add a test that fails without the fix, and, if you can, **mutation-check** it (revert the fix and confirm the test fails).

## Scripts that measure real models

These spend quota; ration them and use `scripts/with-app-key.cjs` so keys are never typed or logged. They run with `npx vite-node --config vitest.config.ts scripts/<name>.mts -- <provider> <model>` (`vite-node` is pinned in `devDependencies`); `npm run eval:routing` and `npm run eval:cache` are shortcuts for the two main ones.

- `routing-eval.mts`: the role manifest's examples replayed against a provider with the router's real prompt and tool list (non-deterministic: run per model, several times), plus a replay probe (does the provider accept a history containing a call to a tool that is not in the request's list?).
- `plan-probe.mts`: how reliably a model returns a valid plan, prompt-only versus structured output.
- `cache-probe.mts`: time to first token and cached tokens over repeated identical requests.
- `role-probe.mts`: whether each pinned specialist answers as itself in a conversation other roles answered in.

`agents/paced-provider.ts` wraps a provider to respect per-minute and daily limits on free tiers, and ends the run when a request can never fit.

## Manual testing (`docs/manual_testing.md`)

A numbered plan, run top to bottom with a report template: smoke test, the handoff and routing sections, MCP and containment, first-run on a fresh profile, regression checks, Anthropic caching, user-defined roles, settings export/import, setting up real data sources from scratch, and outside-workspace access. It exists because mocked tests cannot tell whether a real model follows the roles, the handoff and the tools. The header of the file describes an earlier branch and test count; the sections are the useful part. Record results in `TASKS.md` against the item, with what was actually run.

Features that only a real machine can verify, and where they are recorded: per-platform packaging and bundled runtimes (`TASKS.md` #202, #207, #208), native file dialogs, Keychain, Gatekeeper and SmartScreen.

## Testing a running app

For renderer or runtime work, run a **throwaway copy** (a new `--user-data-dir`, a throwaway `SACHIV_WORKSPACE_DIR`) and drive it over CDP (`--remote-debugging-port`); capture only the window, delete the copy of any database afterwards, and never read the real profile. `scripts/docs-screenshots/` is a working harness: launch, wait for text, click by label, seed rows with the `sqlite3` tool, replace the main-process `chat:send` handler through `--inspect` to produce a turn without a model, and capture.

## Continuous integration

CI is **manual**: `gh workflow run CI --ref <branch>` runs typecheck, build and tests on macOS, Windows and Ubuntu. Run it before a release and after anything platform-sensitive. A Windows-only failure has exposed real bugs (path and file-lock behaviour) that the Mac and Linux runs do not show. See [Build, release and CI](11-build-release-ci.md).
