# Release process (proposal, 2026-10-19; awaiting Deepak's approval)

How a release such as 0.3.2 is built, verified on other machines, tagged and published. Based on what the repository does today (`release.yml`, `windows-dist.yml`, `macos-dist.yml`, `linux-dist.yml`, `ci.yml`, the earlier 0.2.x and 0.3.x releases).

## 1. Branching

- **Triage, plans and documentation-only changes** are committed straight to `main`, as now.
- **Code for a release goes on a release branch**, `release/0.3.2`, created from `main`. Reason: `main` stays the last known good state, an unfinished or unverified change never sits on `main`, and the other machines can be pointed at one named branch. The branch is pushed after **every item** (the power-cut rule), so the branch on GitHub is always the source of truth.
- **One commit per item** (or per coherent part of an item), message starting with the task number, for example `#141 Retry the planning call once when its reply is empty`. Each commit includes its tests and its `TASKS.md` note. Item work never mixes two items in one commit.
- When the release is verified, the branch is merged into `main` with a fast-forward (`git merge --ff-only`), as for 0.2.0 to 0.3.1, so history stays linear. Then the branch is deleted.
- 0.4.0 and 0.4.1 follow the same pattern (`release/0.4.0`, `release/0.4.1`).

## 2. Verification, step by step

| Stage | Where | What | Who |
|---|---|---|---|
| 1. Per item | This Linux machine | Unit tests for the item, then `npm run typecheck` and the full `npx vitest run` (Node 24 via `nvm use 24`). Live check against a real model where the item needs one (isolated Electron with the debugging port, as before). | Claude |
| 2. Whole branch | GitHub Actions | `gh workflow run CI --ref release/0.3.2` builds and tests on Linux, macOS and Windows runners. Manual only (pushes do not start CI). | Claude starts, Deepak sees the result |
| 3. Installers from the branch (no tag) | GitHub Actions | `gh workflow run "Windows installer (manual)" --ref release/0.3.2` and the macOS and Linux equivalents produce downloadable installers as run artifacts (kept 14 days). Nothing is published and no tag is created. | Claude starts, Deepak downloads |
| 4. Windows VM | Deepak's Windows VM | Install the Windows installer from stage 3 over the existing install (upgrade path: settings, chats and workspace kept), then run the checklist below. | Deepak |
| 5. Mac | Deepak's Mac | Install the `.dmg` from stage 3 (right-click, Open, or the `xattr -cr` step in the User Guide), upgrade-path first, then the checklist. For a quick look at one fix a source run also works: `git fetch && git checkout release/0.3.2 && npm ci && npm run dev` (Node 24). | Deepak |
| 6. Sponsor's Windows machine | Sponsor | Only after stages 1 to 5 pass, via the published release (section 3). | Sponsor |

**Checklist for stages 4 and 5.** For each item in the release Claude provides a short "how to check it" list (what to do, what you should see), drawn from `docs/manual_testing.md` and the item's note. Deepak reports pass or fail per item; Claude records the result in the item's `TASKS.md` note and in `docs/manual_testing.md`, and fixes failures on the same branch. The release is not tagged until every item passes or is explicitly moved out.

## 3. Tagging and publishing

Pushing a tag is outward-facing (it starts three platform builds and creates a draft GitHub Release), so **Claude asks before every tag push and before anything is published**.

1. All items verified (section 2); documentation updated per the standing rule (`docs/docs-outline.md`): both guides, `docs/manual_testing.md`, PDFs regenerated.
2. On the release branch: bump the version in `package.json`, the root entries of `package-lock.json`, and the `clientInfo` version in `src/main/mcp/client.ts`; add the `[0.3.2]` section to `docs/CHANGELOG.md`. Commit "Release 0.3.2".
3. Merge to `main` with `--ff-only` and push `main`.
4. Create the annotated tag `v0.3.2` on that commit and push it (after Deepak's go-ahead). `release.yml` builds macOS, Windows and Linux, creates one **draft** release and uploads the installers (the Windows installer re-zipped).
5. Deepak opens the draft, checks the assets (names, sizes), optionally installs once more, and **publishes manually**. The in-app update banner appears only once the release is published.
6. If the tag build fails, fix on `main`, delete the tag and draft release, and tag again (this happened with 0.3.1; the workflow lessons are recorded in `release.yml`).
7. Update the memory and `TASKS.md` with the release state; copy the PDFs to the release page or the sponsor.

## 4. Rules that stay as they are

- Node 24 for tests and builds (Node 20 crashes `better-sqlite3`).
- A feature is not finished until its documentation is.
- No `--no-verify`, no force-push; no tag, release publication or message to the sponsor without Deepak's approval.
- Items found during verification become new numbered `TASKS.md` items; a defect in the release's own items is fixed on the branch.

## 5. Release sequence (from `docs/release_triage.md`)

- **0.3.2:** 12 items (defects and small enhancements).
- **0.4.0:** the Ollama block and the files block (#214, #224, #225, #168, #228, #229, #216, #169).
- **0.4.1:** PDF reader (#196), Microsoft 365 email (#79), Anthropic extended thinking (#159), search (#189, #190). #79 starts early: the administrator's registration steps are written first so the sponsor's IT administrator can act while the code is built. Whether #217 ships alone as a point release is decided after 0.4.0.
- **0.5.0:** design and detail work.
