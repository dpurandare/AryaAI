# Manual test plan: Sachivji 0.3.2

For Deepak. Written 2026-10-20 for the `release/0.3.2` branch, version **0.3.2**. The general regression list stays in `docs/manual_testing.md`; this document covers only what 0.3.2 changed, plus a short smoke test, with the exact prompts and steps to use. Release note: [`docs/releases/0.3.2.md`](releases/0.3.2.md).

**What is already verified (so you do not need to repeat it).** The automated suite (1,681 tests) and the type check pass on Linux. Items #193, #230, #131, #204 (export), #218 were also driven live in an isolated Electron on Linux. **Nothing has been run on Windows or macOS yet, and no cloud model has run the new prompts.** That is what this plan is for.

**Nothing here publishes anything.** The installers come from the GitHub Actions runs on the branch (kept 14 days); the sponsor gets no build until you publish the draft release, after testing and any fixes (`docs/release_process.md`).

## How to use this

- Work through the sections in order. Each test has an **ID** (T1, T2, ...), the **exact steps or prompt**, and **what you should see**. Mark **Pass / Fail / Odd** in the results table at the end; paste anything odd (a screenshot, the reply text, the model used) into the Notes column.
- **Which machines.** The upgrade, single-instance and installer checks matter most on **Windows** (the sponsor's platform) and **macOS**. The model and prompt checks can run on any one machine, but run T9 (greetings) at least once on **OpenAI `gpt-4o-mini`**: that is where it failed.
- **Which model.** Write down the provider and model for every model-dependent test. A small or cloud model behaves differently from the 9B local one.
- Press **Ctrl+O** (Windows, Linux) or **Cmd+O** (macOS) to show tool output in full when a test says "see the tool calls".

Rough time: section A 15 min per OS, B to H about 60 min, I 15 min.

## The builds to test

Built from commit `9ae657d` on `release/0.3.2` (CI green on Windows, macOS and Linux, run 39374736316) on 2026-10-20. **They expire on 2026-11-03** (14 days); if a fix is made, the installers are rebuilt and these links are replaced. Downloading needs a GitHub login with access to the repository.

| OS | Artifact (zip containing the installer) | Size | Run |
|---|---|---|---|
| Windows | [sachivji-windows-installer](https://github.com/dpurandare/AryaAI/actions/runs/39375049107/artifacts/12243097748) | 286 MB | [39375049107](https://github.com/dpurandare/AryaAI/actions/runs/39375049107) |
| macOS (Apple Silicon) | [sachivji-macos-installer](https://github.com/dpurandare/AryaAI/actions/runs/39375051786/artifacts/12243790002) | 514 MB | [39375051786](https://github.com/dpurandare/AryaAI/actions/runs/39375051786) |
| Linux | [sachivji-linux-installer](https://github.com/dpurandare/AryaAI/actions/runs/39375054447/artifacts/12243620433) | 706 MB | [39375054447](https://github.com/dpurandare/AryaAI/actions/runs/39375054447) |

From a terminal instead (GitHub CLI, signed in): `gh run download 39375049107 -R dpurandare/AryaAI -n sachivji-windows-installer` (use `39375051786` / `sachivji-macos-installer` and `39375054447` / `sachivji-linux-installer` for the others).

## Where things are, per operating system

| | Windows 11 | macOS (Apple Silicon) | Linux |
|---|---|---|---|
| Installer from the Actions run | `Sachivji Setup 0.3.2.exe` (inside the artifact zip; a wizard, per user, you can choose the folder) | `Sachivji-0.3.2-arm64.dmg` | `sachivji_0.3.2_amd64.deb` or `Sachivji-0.3.2.AppImage` |
| App data (database, settings) | `%APPDATA%\Sachivji` | `~/Library/Application Support/Sachivji` | `~/.config/Sachivji` |
| Workspace (default) | `Documents\Sachivji Workspace` | `~/Documents/Sachivji Workspace` | `~/Documents/Sachivji Workspace` |
| Shell the assistant uses | **PowerShell** | bash/zsh | bash |
| Cycle agent shortcut | Ctrl+Tab | **Ctrl+Tab** (not Cmd+Tab) | Ctrl+Tab |
| Show tool output | Ctrl+O | Cmd+O | Ctrl+O |

---

## A. Install and upgrade (every OS)

Do this first, on top of your existing 0.3.1 install, so the upgrade path is tested.

| ID | Steps | Expect |
|---|---|---|
| **T1** | Close Sachivji. Install the 0.3.2 installer **over** 0.3.1. **Windows:** run the `.exe` from the artifact (SmartScreen: More info, Run anyway). **macOS:** open the `.dmg`, drag to Applications; if blocked, right-click the app, Open, or run `xattr -cr /Applications/Sachivji.app`. **Linux:** `sudo dpkg -i <file>.deb` or run the AppImage. | Installs without error. |
| **T2** | Start Sachivji. Open the account menu (bottom left), choose **About**. | The version reads **0.3.2**. The first-run screens do **not** appear. |
| **T3** | Look at the chat list, then open an old chat. Open Settings. | Your old chats, provider keys, MCP servers and settings are all still there. Settings > Runtime shows Python ready. |
| **T4** | Send: `Say hello in one sentence.` | A normal reply, no error. |

**macOS only:** after T2, quit with **Cmd+Q** and reopen from Launchpad: it must start normally.
**Windows only:** the Start menu entry and the desktop shortcut both start 0.3.2.

---

## B. Only one Sachivji at a time (#131)

| ID | Steps | Expect |
|---|---|---|
| **T5** | With Sachivji **open**, start it again. **Windows:** click the Start menu entry (or the desktop icon) a second time. **macOS:** in Terminal run `open -n -a Sachivji` (a Finder double-click only switches to the running app; that is normal on macOS). **Linux:** run the same command or AppImage a second time. | A message box titled **"Sachivji is already running"** appears: "Another Sachivji window is already open. Close it before starting a new one. This launch will now exit." Click **OK**: the second launch ends. The first window comes to the front and still works (send a message to check). |
| **T6** | Close the first Sachivji completely, then start it once. | Starts normally. |

**Linux (Wayland):** on the Linux dev machine the dialog could not be screenshotted, so please confirm the box is really visible on your desktop, not only printed in a terminal. If you ever see only terminal text and no box, record it as Fail.

---

## C. Agent menu (#193)

| ID | Steps | Expect |
|---|---|---|
| **T7** | In a chat, click **Agent: Auto** in the status bar (bottom left, above the window edge). | A menu opens **upward**, above the button, listing **Auto, Planner, Researcher, History Analyst, Developer, Data Access, Data Processor, Text Document Creator, Configurator, MCP Operator, Email**. **Auto** has a tick. Hovering a row shows a short description. |
| **T8** | Click **Researcher**. Then open the menu again and press **Down** twice and **Enter**. Then open it and press **Esc**. Then open it and click somewhere in the chat. | The button reads **Agent: Researcher**; the second choice is **Developer** (Down twice from Researcher: History Analyst, Developer); Esc closes the menu; a click outside closes it. Keyboard focus returns to the button. The pinned button is highlighted. |
| **T8b** | Click in the message box and press **Ctrl+Tab** (also on a Mac: Ctrl, not Cmd) several times, then **Ctrl+Shift+Tab**. | Cycles through the same list forward and back, as before. |
| **T8c** | (If you have a user-defined role in `Settings > Your own roles`.) Open the menu. | Your role appears in the list. |

---

## D. Confirm before deleting a chat (#230)

| ID | Steps | Expect |
|---|---|---|
| **T9a** | Click **New chat** twice so you have chats you do not need. Hover a chat that is **not** the open one and click the **×**. | A dialog **"Delete this chat?"** names the chat and says it will be deleted permanently and cannot be undone, and mentions exporting first. The **Cancel** button has the focus. |
| **T9b** | Press **Esc**. Click **×** again and click **Cancel**. Click **×** and click outside the dialog. | The chat is still in the list each time. |
| **T9c** | Click **×**, then **Delete**. | The chat disappears. |
| **T9d** | Look at the **open** chat's row, and at a chat that is generating (send a long request such as `Write a 600 word essay on solar energy` and switch to another chat while it runs). | Neither shows an **×**. |

---

## E. Specialists introduce themselves (#215)

Run on **OpenAI `gpt-4o-mini`** first (the model where it failed), then once on your usual model.

For **each** specialist below: open a **new chat**, pin it from the Agent menu, send the **first** prompt, then send the **second** prompt in the same chat.

Specialists: Planner, Researcher, History Analyst, Developer, Data Access, Data Processor, Text Document Creator, Configurator, MCP Operator, Email.

| ID | Prompt 1 | Prompt 2 | Expect (each) |
|---|---|---|---|
| **T10** | `Hello` | `What can you do?` | The reply says **which specialist it is** (for example "I'm the Researcher specialist") **and** lists its main abilities in a few lines. A bare "Hello! How can I assist you today?" is a **Fail** for that specialist. |

Record the number of specialists that pass out of 10, per model. (On a local 0.8B model all of them passed in the automated probe; the cloud small model is the real test.)

---

## F. MCP Operator is offered only when a server is connected (#146)

| ID | Steps | Expect |
|---|---|---|
| **T11** | Settings > MCP servers: make sure **no** server is connected (disable or remove them; note which you changed). In **Auto**, send: `Look up the inverter fault runbook in our wiki.` Expand the tool output. | The work goes to the **Researcher** (web), not the **MCP Operator**. The reply says plainly that no wiki or knowledge server is connected, rather than failing or inventing an answer. No `delegate_to_mcp_operator` call. |
| **T12** | Connect the test server: Settings > MCP servers > **Add**: name `test_wiki`, description `Test wiki: runbooks and guides`, Local (stdio), command `node`, args = the **absolute path** of `scripts/manual-test-mcp-server.mjs` in a checkout (needs the repo and `npm install` on that machine; on the Windows VM use your own MCP server if you have one, or skip T12 and say so). It should show Connected, 3 tools. Then send the same prompt: `Look up the inverter fault runbook in our wiki.` | Now the **MCP Operator** handles it (agent chip "MCP Operator", a `mcp__test_wiki__...` tool call). The reply mentions `inverter-fault-runbook`. |

---

## G. Files stay out of the workspace root (#204)

Use a fresh chat, **Auto** agent. Look at the workspace folder in Explorer, Finder or the file manager after each test.

| ID | Prompt or steps | Expect |
|---|---|---|
| **T13** | Developer prompt (all OS): `Write a Python script that draws 5 charts of random data (bar, line, pie, scatter, histogram) and saves them as chart1.png to chart5.png. Save them using exactly those bare file names, in the current folder, no sub-folders. Then run it.` | All five PNGs end up in **`resources/`**, **not** in the workspace root. The reply says the files were moved, with `chart1.png -> resources/chart1.png` style paths (forward slashes, also on Windows). |
| **T14** | **macOS / Linux**, prompt: `Use the shell to run exactly this command: for i in 1 2 3 4 5; do echo x > note_$i.png; done` | The shell reply ends with a "Moved 5 file(s) the command left in the workspace root" note; the files are in `resources/`, none in the root. |
| **T14w** | **Windows**, prompt: `Use the shell to run exactly this command: 1..5 \| ForEach-Object { Set-Content -Path "note_$_.png" -Value x }` | Same as T14: moved to `resources/`, the reply lists the new paths with `/`. |
| **T15** | Prompt: `Use the shell to create two files, a.txt and b.txt, each containing the word hello, in the workspace root.` | The two files **stay in the root** (fewer than four new files: they are taken to be what you asked for). No "Moved" note. |
| **T16** | Prompt: `Where should you save charts, documents and scratch files? Use get_environment.` | The answer names `resources/`, `documents/`, `exports/` and `tmp/` and mentions that a bare name in a script lands in the root. |
| **T17** | Account menu > **Export Settings...** | The Save dialog opens in the workspace's **`exports/`** folder (created if it was missing), not the root. Save it, then check the file is there. (Windows: the path shows `exports\`.) |

---

## H. Auto-approve rules (#218)

| ID | Steps | Expect |
|---|---|---|
| **T18** | Settings > scroll to **Auto-approve rules**. | An explanation paragraph; a **Refresh list** button; every row has a tag in brackets: **(Built-in)**, **(Saved query)** or **(MCP server: name)**. Built-ins come first. |
| **T19** | Find `db_execute_sql`, `api_call` and `git_exec`. | Each has a red note that ticking skips confirmation for **all** its calls, writes and deletes included; `db_execute_sql` / `api_call` also say it applies to every database / API connection. |
| **T20** | With the test server connected (T12): Settings > Auto-approve rules > **Refresh list** (or reopen Settings). | Rows named `mcp__test_wiki__create_page` (and others) appear, tagged **(MCP server: test_wiki)**, with the "server did not mark this tool read-only" note. |
| **T21** | Tick `mcp__test_wiki__create_page`. Then Settings > MCP servers > **remove** `test_wiki`. Reopen Settings > Auto-approve rules. | The row is gone from the main list; a section **"Saved rules for tools that are not available now"** lists `mcp__test_wiki__create_page` with a **Remove** button. Click **Remove**: it disappears; reopening Settings confirms it is gone. |
| **T22** | Add the server again, **while Settings is open**: Settings > MCP servers > Add (as T12), then look at Auto-approve rules without leaving Settings. | The new server's rows appear (possibly after **Refresh list**). |
| **T23** | Tick `write_file` in the rules. In a chat send: `Write the text hello to a file called one.txt` | It writes **without** a confirmation dialog. Untick `write_file`: the next write asks again. |
| **T24** | Switch on the session setting **Auto-approve tool calls for this session** (in a confirmation dialog), then send: `Read the file C:\Windows\win.ini` (Windows) or `Read the file /etc/hostname` (macOS/Linux). | An **"Allow access outside the workspace?"** question still appears: access outside the workspace is **never** auto-approved. Answer **Deny** or "just this once". |

---

## I. Smoke test: nothing else broke (every OS, 15 min)

| ID | Prompt or steps | Expect |
|---|---|---|
| **T25** | `Make a bar chart of the numbers 3, 7 and 5 and save it as resources/bars.png.` | A Python run; the chart image appears in the reply; the file is in `resources/`. |
| **T26** | `Create a Word document called hello.docx with the heading Hello and one short paragraph.` | `documents/hello.docx` exists and opens in Word. |
| **T27** | `What is in my workspace? Use get_environment and list the folders.` | Correct workspace path and OS; PowerShell on Windows, bash on macOS/Linux. |
| **T28** | **Windows only**, prompt: `Run the command Get-Location in the shell.` | The path shown is the workspace; PowerShell syntax works (no cmd.exe errors). |
| **T29** | Ctrl + `+`, Ctrl + `-`, Ctrl + `0` (Cmd on macOS). Close and reopen. | The zoom changes and is remembered. |
| **T30** | Settings: toggle the theme, open and close Settings with the account arrow. | No errors; the theme changes. |
| **T31** | Send `Compare Python and Rust in two sentences.` with **Planner** pinned, then with **Auto**. | Both answer; no empty replies, no error banner. |

---

## J. Not testable by hand (checked by the automated tests only)

- **#170** (old file listings kept compact when the context is full): the unit tests cover it; it only shows in a very long session on a small-context model. Optional manual try on a local model with a small context: ask it to `List the folder docs`, then read several large files in turn, then ask `Which files were in docs? Name the first ten.` The names should be right, not invented.
- **#140 / #141** (empty planning reply): the retry was already in place; 0.3.2 only adds the stop reason and token count to the **log**. Nothing visible to test. Optional (developer machine): `npm run` the planning probe, `npx vite-node --config vitest.config.ts scripts/plan-probe.mts -- ollama <model>` and look for `stop=... outTokens=...` on any BAD line.
- **#134** (pinned `vite-node`, `npm run eval:routing`, `eval:cache`) and **#221** (cloud CLI tests): developer-only.

---

## Results

Tester: Deepak. Date: ____. Build: 0.3.2 from the Actions run: ____. Machine / OS: ____.

| ID | Item | Pass / Fail / Odd | Model / OS | Notes |
|---|---|---|---|---|
| T1 | Install over 0.3.1 | **Pass** | Linux (2026-10-20) | Deepak; installer type not stated |
| T2 | Version shows 0.3.2 | **Pass** | Linux (2026-10-20) | Deepak; installer type not stated |
| T3 | Data kept | **Pass** | Linux (2026-10-20) | Deepak; installer type not stated |
| T4 | First message | **Pass** | Linux (2026-10-20) | Deepak; installer type not stated |
| T5 | Second launch message (#131) | **Pass** | Linux (2026-10-20) | Deepak; the visible-box check on the Linux desktop was part of T5 |
| T6 | Normal start after close | **Pass** | Linux (2026-10-20) | Deepak; the visible-box check on the Linux desktop was part of T5 |
| T7 | Agent menu opens upward (#193) | **Pass** | Linux (2026-10-20) | Deepak |
| T8 | Menu selection, keys, Esc, outside click | **Pass** | Linux (2026-10-20) | Deepak |
| T8b | Ctrl+Tab still cycles | | | |
| T8c | User-defined role in menu | | | |
| T9a-d | Delete confirmation (#230) | | | |
| T10 | Greetings, 10 specialists, model 1: ___ / 10 | | | |
| T10 | Greetings, 10 specialists, model 2: ___ / 10 | | | |
| T11 | No MCP server: Researcher (#146) | | | |
| T12 | MCP server connected: MCP Operator | | | |
| T13 | Python charts not in root (#204) | | | |
| T14 / T14w | Shell files moved (#204) | | | |
| T15 | Two files stay in root | | | |
| T16 | get_environment wording | | | |
| T17 | Export Settings opens in exports/ | | | |
| T18 | Auto-approve tags and refresh (#218) | | | |
| T19 | Red notes on sometimes-mutating tools | | | |
| T20 | MCP rows appear | | | |
| T21 | Stale rule listed and removable | | | |
| T22 | List updates with Settings open | | | |
| T23 | A ticked rule skips the dialog | | | |
| T24 | Outside-workspace access never auto-approved | | | |
| T25 to T31 | Smoke tests | | | |

When everything is Pass (or the failures are fixed and re-tested), tell Claude: it will record the results in `TASKS.md` and `docs/manual_testing.md`, then ask for your go-ahead to merge, tag and build the draft release.
