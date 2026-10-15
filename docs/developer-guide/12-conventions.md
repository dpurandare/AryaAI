# 12. Conventions

How this project is worked on. Most of these were learned from a failure, which is why they are firm.

## Principles

- **Enforce in code, not in prompts.** Cheap and local models ignore prompt rules. Validation, refusals, completion gates, loop breakers, file placement and the handoff contract are implemented in code; the prompt only explains them. When a model misbehaves, first ask whether code can make the wrong thing impossible or detectable, before adding a sentence to a prompt. Every sentence in a prompt costs tokens on every request (see the prompt-budget test).
- **The user is the safety gate.** A tool that changes something declares `mutates` and goes through the confirmation. Never add a path that mutates without it; never let a secret travel through chat.
- **Fail with a message the model or the user can act on.** Say what was wrong and what to do instead; name the right tool in a refusal.
- **Fix the root cause, then guard it.** A bug found live gets a fix, a test that fails without the fix (ideally mutation-checked), and a comment saying what was seen.
- **Be honest about what was verified.** In commit messages, `TASKS.md` and reports, separate what was **run** (and where) from what was only typechecked or unit-tested. Do not claim a UI change works until it has been seen in a running app.

## Code comments

The code carries long comments on purpose. They record **why** (the failure that was seen, the provider behaviour that was confirmed, the alternative that was rejected) with the `TASKS.md` number, not what the line does. Match the surrounding density and idiom; keep new comments to the reasons a future reader would otherwise have to rediscover. Names, formatting and structure follow the file you are editing.

## Cross-platform rules

- Never assume a path separator, a shell or a home folder. Use `node:path` and Electron's `app.getPath`.
- Windows behaves differently for file locks (an open SQLite handle blocks deleting its folder: close handles), line endings (`*.cmd` is forced to CRLF by `.gitattributes`), and OneDrive's redirected Documents folder (the default workspace avoids it).
- Prefer a portable test: a test that depends on file permissions or symlinks needs a Windows branch. A Windows CI run has caught several such bugs.
- Bundled-resource lookups return `undefined` outside Electron; keep that so tests and dev runs stay no-ops.

## Security rules

- Secrets live only in the secret store; settings and exports never contain them.
- File tools go through the workspace guard; outside access is read-only and user-approved. Shell and Python are not sandboxed; the confirmation is their safeguard, so keep their descriptions honest.
- Treat everything that comes from outside as untrusted data: web pages, tool results, MCP descriptions, role files from elsewhere. Cap and label it, and never promote it to an instruction.
- **The repository is public.** Do not commit real names, addresses, keys, hostnames, customer data or private paths; use fictional examples (`example.com`, "Acme Corp"). Remember that Git history is permanent.
- Do not put a secret on a command line, in a log, or in a test fixture.

## Commits and branches

- Work on `main`; use a short-lived branch for large or risky changes and merge it after a manual CI run.
- **One purpose per commit.** If a file mixes two purposes, split them into separate commits and test each stage. Say in the message what was and was not tested.
- Messages explain the change and the reason, and reference the `TASKS.md` number. Commits made with Claude Code end with the co-author line the tool provides.
- Do not push or tag unless that is the task; releases follow [Build, release and CI](11-build-release-ci.md). CI is manual: run `gh workflow run CI --ref <branch>` before a release.
- Never commit `release/`, `out/`, `resources/` fetched assets, databases or `.env` files (all git-ignored).

## TASKS.md

`TASKS.md` is both the backlog and the engineering log.

- Every item has a **stable number**; never renumber. `- [ ]` is open, `- [x]` is done. New work gets the next free number.
- An item records the request or finding with its date and source, the analysis, the decision and its reason, what was done, **what was verified and how**, and what is left. Update the item as the work proceeds, instead of adding a second place.
- Findings from live runs (which model, which prompt, what happened) are the most valuable entries: they are why the safeguards exist.
- User-action items are marked as such (for example "TODO (Deepak)").

## Design documents

`docs/design-discussion.md` holds design decisions and their reasoning (the redesign into roles as data, the typed handoff, prompt budgets, caching, user-defined roles); `docs/thouthts.md` is the original requirements. When a decision changes, update the design document in the same change. `docs/CHANGELOG.md` is user-facing release notes: keep `[Unreleased]` current as changes land, and write for a reader who does not know the code.

## Documentation

- A user-visible change updates the matching **User Guide** page in the same change (and the tool catalog if tools changed: `node scripts/gen-tool-catalog.mjs --app <executable>`; screenshots: `npm run docs:screenshots`). A structural change updates this guide.
- Claims in the guides are checked against the code. Prefer generating a table from the running app over copying it by hand.
- Screenshots come from a throwaway profile with invented data; check every image for personal paths, names and keys before committing it.
- Shell snippets in documentation are pasted into interactive shells (zsh included): no unquoted word-splitting of variables, no parentheses or apostrophes in `#` comments.
- `README.md` stays a short quickstart; it links to the guides.

## Working with models during development

- Real-model runs spend the owner's quota. Prefer tool-level checks and mocked tests; ration eval runs, and ask before repeating one.
- A throwaway app run that sends real messages counts too.
- Record which model and provider a finding came from; behaviour varies a lot between a 9B local model and a frontier one.

## Dependencies

Pin versions that matter (the bundled Python packages are pinned so every platform supports the same minimum Python; runtime downloads are pinned and checksum-verified). Prefer a package already in `package.json` over a new one, and note the license: the app is closed-source, so copyleft (AGPL) libraries are not acceptable.
