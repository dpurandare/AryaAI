# Manual test plan: Sachivji 0.3.2

For Deepak. Written 2026-10-20 for the `release/0.3.2` branch, version **0.3.2**. The general regression list stays in `docs/manual_testing.md`; this document covers only what 0.3.2 changed, plus a short smoke test, with the exact prompts and steps to use. Release note: [`docs/releases/0.3.2.md`](releases/0.3.2.md).

**What is already verified (so you do not need to repeat it).** The automated suite (1,700 tests) and the type check pass on Linux. Items #193, #230, #131, #204 (export), #218 were also driven live in an isolated Electron on Linux. **Nothing has been run on Windows or macOS yet, and no cloud model has run the new prompts.** That is what this plan is for.

**Nothing here publishes anything.** The installers come from the GitHub Actions runs on the branch (kept 14 days); the sponsor gets no build until you publish the draft release, after testing and any fixes (`docs/release_process.md`).

## How to use this

- Work through the sections in order. Each test has an **ID** (T1, T2, ...), the **exact steps or prompt**, and **what you should see**. Mark **Pass / Fail / Odd** in the results table at the end; paste anything odd (a screenshot, the reply text, the model used) into the Notes column.
- **Which machines.** The upgrade, single-instance and installer checks matter most on **Windows** (the sponsor's platform) and **macOS**. The model and prompt checks can run on any one machine, but run T9 (greetings) at least once on **OpenAI `gpt-4o-mini`**: that is where it failed.
- **Which model.** Write down the provider and model for every model-dependent test. A small or cloud model behaves differently from the 9B local one.
- Press **Ctrl+O** (Windows, Linux) or **Cmd+O** (macOS) to show tool output in full when a test says "see the tool calls".

Rough time: section A 15 min per OS, B to H about 60 min, I 15 min.

## L. What is still to do (updated 2026-10-22)

Nothing here is a failure; it is the list of what has not been run yet. Tick them off in the Results table (rows L1 to L12). **L1 to L3 need the NEXT build** (fixes made after `7aca87e`: #239, #240, #241); Claude will say when it is built and put its links in "The builds to test".

| ID | Where | Steps | Expect |
|---|---|---|---|
| **L1** (#240) | next build, any OS | Settings > MCP servers: add `test_wiki` (see the appendix; its tools are not read-only). Export settings, remove the server, then Import the file. Do NOT restart. | The server is listed as **Connected · 3 tools** and the three `mcp__test_wiki__...` rows are in Settings > Auto-approve rules (Refresh list if needed). |
| **L2** (#239) | next build, any OS | Click the provider/model text in the status bar: the box opens. Click somewhere else in the window (chat area, sidebar). Open it again and press Escape. Open it again and click the trigger once more. | The box closes on a click elsewhere, on Escape and on a second click of the trigger. Choosing a provider or model inside the box still works. |
| **L3** (#241) | next build, Windows first | Add `test_wiki` with the script **alone** in a folder with no `node_modules` (the failure you saw). Then with a wrong path. Then with command `nodee`. | Short red status line with the cause: "Cannot find package ... npm install", "The file to run was not found", "The command was not found". A **Show details** link opens the command, the error and the server output; Reconnect after fixing connects it. |
| **L4** (T14w) | Windows VM | Run T14w (section G). | Files moved to `resources/`, paths listed with `/`. |
| **L5** (T28) | Windows VM | Run T28 (section I). | Workspace path shown; PowerShell syntax works. |
| **L6** (T1, upgrade) | Windows VM | Run T1: install 0.3.2 over 0.3.1 (SmartScreen: More info, Run anyway). | Installs; the app starts; settings and chats are still there. |
| **L7** (I) | Windows VM | Smoke tests T25 to T31 (section I). | As in the table of section I. |
| **L8** (macOS) | Mac | Run T1 (dmg, `xattr -cr` if blocked) and T5 (`open -n -a Sachivji`). | As T1 and T5. |
| **L9** (macOS) | Mac | Section K (R1 to R9). | As section K. |
| **L10** (R1..R9) | Ubuntu 20.04 machine | Section K (R1 to R9). | As section K. |
| **L11** (R1 odd) | any | Not a test: Deepak decides whether the varying greetings when several agents are pinned in turn in ONE chat are acceptable for 0.3.2 or need a fix. | Decision recorded. |
| **L12** (T10) | any | Not a test: OK to use the stored OpenAI key for the greeting probe, or re-run T10 (`gpt-4o-mini`) by hand. | Result recorded. |

---

## The builds to test

Built from commit `7aca87e` on `release/0.3.2` (CI green on Windows, macOS and Linux, run 39554420985) on 2026-10-21, after the fixing cycle (#232 to #238). The first builds (`9ae657d`) were replaced and deleted. **They expire on 2026-11-04** (14 days); if a fix is made, the installers are rebuilt and these links are replaced. Downloading needs a GitHub login with access to the repository.

| OS | Artifact (zip containing the installer) | Size | Run |
|---|---|---|---|
| Windows | [sachivji-windows-installer](https://github.com/dpurandare/AryaAI/actions/runs/39554659097/artifacts/12324679478) | 286 MB | [39554659097](https://github.com/dpurandare/AryaAI/actions/runs/39554659097) |
| macOS (Apple Silicon) | [sachivji-macos-installer](https://github.com/dpurandare/AryaAI/actions/runs/39554661914/artifacts/12325211201) | 513 MB | [39554661914](https://github.com/dpurandare/AryaAI/actions/runs/39554661914) |
| Linux | [sachivji-linux-installer](https://github.com/dpurandare/AryaAI/actions/runs/39554664793/artifacts/12324928615) | 706 MB | [39554664793](https://github.com/dpurandare/AryaAI/actions/runs/39554664793) |

From a terminal instead (GitHub CLI, signed in): `gh run download 39554659097 -R dpurandare/AryaAI -n sachivji-windows-installer` (use `39554661914` / `sachivji-macos-installer` and `39554664793` / `sachivji-linux-installer` for the others).

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
| **T10** | `Hello` | `What can you do?` | The reply says **which specialist it is, by its Agent-menu name** ("Researcher", not "Research specialist"), says what it does in two or three lines **and names its main tools** (the tool names, about eight at most). It does not end with a generic "How can I assist you today?". The reply to **What can you do?** is fuller (every tool with what it is for, limits, who takes what it does not do) and is not the first reply reworded. A bare "Hello! How can I assist you today?" is a **Fail** for that specialist. (Expectation tightened after the first test round, #232.) |

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
| **T24** | **Corrected 2026-10-20 (the first version used `/etc/hostname`, which is a protected system location: the app refuses it outright and never asks, so it could not test the rule).** Prepare a test file in a normal folder outside the workspace that is not already allowed in Settings > Workspace > Folders outside the workspace: **Linux / macOS:** run `echo hello > ~/Downloads/sachiv_t24.txt`; **Windows (PowerShell):** `Set-Content "$env:USERPROFILE\Downloads\sachiv_t24.txt" hello`. Then switch on **Auto-approve tool calls for this session** (tick it in any confirmation dialog, e.g. after `Write the text hi to a file called t24.txt`), and send: `Use the read_file tool to read /home/<you>/Downloads/sachiv_t24.txt` (macOS: `/Users/<you>/Downloads/...`; Windows: `C:\Users\<you>\Downloads\sachiv_t24.txt`). **Give the full absolute path, never `~`: the file tools do not expand `~` (the first attempt got `ENOENT ... Sachivji Workspace/~/Downloads/...`, TASKS #235).** **Say "read_file tool": without it the model may use `shell_execute` (`cat ...`), which is a different tool and is not covered by this rule (TASKS #234).** | An **"Allow access outside the workspace?"** question still appears, although the session auto-approve is on. Answer **Deny**; the assistant says it could not read the file. (Answer "just this once" instead to see the content.) |
| **T24b** | Optional, Linux / macOS: with the same session setting on, send `Use the read_file tool to read /etc/hostname`. | **No question at all**: a refusal that the location is protected (credentials, keys, system or Sachivji's own data) and cannot be read. |

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

## K. Re-test after the fixing cycle (build rebuilt from the fix commit)

These re-check what the test round found. Run them on the **rebuilt** installers, on at least Linux; the shell and path ones also on Windows and macOS.

| ID | Steps | Expect |
|---|---|---|
| **R1** (#232, T10 again) | `gpt-4o-mini`, each specialist pinned in a new chat: `Hello`, then `What can you do?`. | As the updated T10: menu name, tools named, no generic closing line, the second reply fuller than the first. |
| **R2** (#232 e, T31 again) | Planner pinned: `Compare Python and Rust in two sentences.` | No self-introduction; it says in one short sentence it is not its job and hands over. Auto answers directly. |
| **R3** (#233, T18-T22 again) | Settings > Auto-approve rules. | A table with columns **Skip confirmation**, **Tool** (name and source), **What it does** (one line). Press **Refresh list**: it shows "Updated <time>: N tools, no changes" (or "k new" after you add or remove an MCP server or save a query). Stale rules appear as their own small table with **Remove**. |
| **R4** (#234) | Tick **Auto-approve tool calls for this session**. Then: `Use shell_execute to run: cat /etc/hostname` | The shell call **still asks** for confirmation, the dialog shows a red **Protected location** warning, and the session checkbox is greyed out with a note for this tool. |
| **R5** (#234) | Same, for `Use shell_execute to run: ls ~/Downloads`. | Asks; a softer **Check the path** warning. Settings > Auto-approve rules: the `shell_execute` row has the "not limited to the workspace" note; ticking its own checkbox there is the only way to skip the question. |
| **R6** (#235, T24 again) | `Read the file ~/Downloads/sachiv_t24.txt` (create it first, any text). | The "Allow access outside the workspace?" question appears for the Downloads folder, then the content is shown. `Read the file ~/.ssh/id_rsa` is refused as a protected location with no question. |
| **R7** (#236, T25 again) | `Make a bar chart of the numbers 3, 7 and 5 and save it as resources/bars.png.` (`gpt-4o-mini`, Auto) | The chart image **appears in the chat**. |
| **R8** (#237, T26 again) | `Create a Word document called hello.docx with the heading Hello and one short paragraph.` | One `office_create_document` call, exactly one paragraph in the file. |
| **R9** (#238, T27 again) | `What is in my workspace? Use get_environment and list the folders.` | No mention of `.sachiv-handoff/`; `templates/` is not claimed to exist unless it does (the tool text says "not created yet"). |

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
| T8b | Ctrl+Tab still cycles | **Pass** | Linux (2026-10-20) | Deepak |
| T8c | User-defined role in menu | **Skipped** | Linux (2026-10-21) | Deepak: skip (no user-defined role) |
| T9a-d | Delete confirmation (#230) | **Pass** | Linux (2026-10-20) | Deepak |
| T10 | Greetings, 10 specialists, model 1: `gpt-4o-mini` | **Fail** | Linux (2026-10-20) | Deepak: "does not give proper response". Claude read the sessions: roles are named and abilities described but no tool list is shown; follow-up **TASKS #232**, fixing cycle |
| T10 | Greetings, 10 specialists, model 2: `claude-haiku-5-5` | **Odd** | Linux (2026-10-20) | Deepak: better than gpt-4o-mini, but the same information is repeated for both prompts (Hello and What can you do?). Follow-up **TASKS #232**, fixing cycle |
| T11 | No MCP server: Researcher (#146) | **Pass** | Linux (2026-10-20) | Deepak |
| T12 | MCP server connected: MCP Operator | **Pass** | Linux (2026-10-20) | Deepak |
| T13 | Python charts not in root (#204) | **Pass** | Linux (2026-10-20) | Deepak |
| T14 / T14w | Shell files moved (#204) | **Pass** (T14, Linux); T14w Windows pending | Linux (2026-10-20) | Deepak |
| T15 | Two files stay in root | **Pass** | Linux (2026-10-20) | Deepak |
| T16 | get_environment wording | **Pass** | Linux (2026-10-20) | Deepak |
| T17 | Export Settings opens in exports/ | **Pass** | Linux (2026-10-20) | Deepak |
| T18 | Auto-approve tags and refresh (#218) | **Pass** (limited scope) | Linux (2026-10-20) | Deepak: tags and sorting fine. Comments, both follow-ups in **TASKS #233** (fixing cycle): the Refresh list button seems to do nothing; show the list as a table with three columns (checkbox, rule name, description) |
| T19 | Red notes on sometimes-mutating tools | **Pass** | Linux (2026-10-20) | Deepak |
| T20 | MCP rows appear | **Pass** | Linux (2026-10-20) | Deepak: 3 `test_wiki` rows seen. The test server has 3 tools and none is marked read-only, so all 3 count as changing things and are listed |
| T21 | Stale rule listed and removable | **Pass** | Linux (2026-10-20) | Deepak |
| T22 | List updates with Settings open | **Pass** | Linux (2026-10-20) | Deepak; whether Refresh list was needed was not stated (relevant to TASKS #233) |
| T23 | A ticked rule skips the dialog | **Pass** | Linux (2026-10-20) | Deepak |
| T24 | Outside-workspace access never auto-approved | **Pass** (with the absolute path; findings #234 and #235 stand) | Linux (2026-10-21) | Deepak: with the session auto-approve on, `read_file` on `/home/deepak/Downloads/sachiv_t24.txt` still showed the "Allow access outside the workspace?" question. Earlier attempts failed because of the shell route (#234) and the unexpanded `~` (#235) |
| T24b | Protected location refused without a question (optional) | **Pass** | Linux (2026-10-21) | Deepak. `read_file` on a protected location is refused with no question (the shell bypass is #234) |
| T25 | Bar chart saved and shown | **Fail** (partial: file correct, image not shown) | Linux (2026-10-21) | Deepak, gpt-4o-mini, Auto: `python_run` ran at the top level and `resources/bars.png` was created, but the chart did not appear in the chat and the reply only named the file. Cause and fix: **TASKS #236** |
| T26 | Word document created | **Odd** (works; wasteful and padded, TASKS #237) | Linux (2026-10-21) | Deepak, gpt-4o-mini: `documents/hello.docx` created and opens, but `office_create_document` was called three times (two rejected by the head-and-tail rule / a misuse of `fromPreviousAnswer`) and the document got an extra, unrequested closing paragraph, so it has 2 paragraphs instead of 1 |
| T27 | get_environment and workspace folders | **Pass** (two odd points, TASKS #238) | Linux (2026-10-21) | Deepak, gpt-4o-mini: path, OS and bash correct; only the top level was listed, which is how `list_directory` works (one level, no recursion). Odd: the reply named `templates/`, which does not exist on disk (taken from the get_environment text), and listed the internal `.sachiv-handoff/` folder |
| T28 | Windows: PowerShell syntax works | **N/A on Linux; pending on Windows** | Linux (2026-10-21) | Deepak ran it on Linux by mistake of the plan (Windows-only test): `Get-Location` is a PowerShell command and bash correctly says it is not recognised; the plain-language prompt ("get the current location") worked via `pwd`, which is also correct. Run on the Windows VM |
| T29 | Zoom shortcuts and remembered level | **Pass** | Linux (2026-10-21) | Deepak |
| T30 | Theme toggle, Settings open/close | **Pass** | Linux (2026-10-21) | Deepak |
| T31 | Planner pinned and Auto both answer | **Pass** (one odd point, in TASKS #232) | Linux (2026-10-21) | Deepak, gpt-4o-mini: both answered. Pinned Planner first said "I'm the Planner specialist, and my main abilities include breaking down requests into clear, actionable plans. However, comparing programming languages ... is outside my scope." and handed the question over (`[handoff: out_of_scope -> Researcher]`), after which the answer came. The hand-over is by design; the unprompted self-introduction is a side effect of the #215 greeting instruction |
| R1 | Greeting shows tools, menu name, no generic close (#232) | **Odd** | Windows 11 AMD64 VM (2026-10-22) | Deepak: works with each agent in a NEW chat; with several agents pinned one after another in the SAME chat the result varies (to investigate) |
| R2 | No introduction on a non-greeting (#232) | **Pass** | Windows 11 AMD64 VM (2026-10-22) | Deepak |
| R3 | Auto-approve table and Refresh feedback (#233) | **Pass** (after analysis; one real bug fixed, #240) | Windows 11 AMD64 VM (2026-10-22), Linux (2026-10-22) | Deepak. Windows: the server tested was Context7 (connected, 2 tools); both tools declare `readOnlyHint: true` (checked by listing its tools), so they need no confirmation and are correctly absent from the table. Linux with a server whose tools are not read-only (`test_wiki`, 3 tools): rows appear after add and after restart, but NOT after a settings import: import wrote the config without connecting the server. Fixed in `da5f572`; needs re-test on the next build (import, then rows appear without restart) |
| R4 | Shell asks despite session auto-approve; protected warning (#234) | **Pass** | Windows 11 AMD64 VM (2026-10-22) | Deepak |
| R5 | Outside-path warning; settings note (#234) | **Pass** | Windows 11 AMD64 VM (2026-10-22) | Deepak |
| R6 | ~ expands; protected refused (#235) | **Pass** | Windows 11 AMD64 VM (2026-10-22) | Deepak |
| R7 | Chart appears in the chat (#236) | **Pass** | Windows 11 AMD64 VM (2026-10-22) | Deepak |
| R8 | One-paragraph Word note, one call (#237) | **Pass** | Windows 11 AMD64 VM (2026-10-22) | Deepak |
| R9 | Workspace overview without internal folder or phantom templates (#238) | **Pass** | Windows 11 AMD64 VM (2026-10-22) | Deepak |
| L1 | Import connects the MCP server (#240) | | | |
| L2 | Model picker closes outside (#239) | | | |
| L3 | MCP startup error and Show details (#241) | | | |
| L4 | Windows: shell files moved (T14w) | | | |
| L5 | Windows: PowerShell (T28) | | | |
| L6 | Windows: installer upgrade, SmartScreen (T1) | | | |
| L7 | Windows: smoke tests (T25-T31) | | | |
| L8 | macOS: dmg and single instance (T1, T5) | | | |
| L9 | macOS: section K | | | |
| L10 | Ubuntu 20.04: section K | | | |
| L11 | Decision on R1 (varying greetings) | | | |
| L12 | T10 greeting probe on gpt-4o-mini | | | |

When everything is Pass (or the failures are fixed and re-tested), tell Claude: it will record the results in `TASKS.md` and `docs/manual_testing.md`, then ask for your go-ahead to merge, tag and build the draft release.

## Appendix: a test MCP server whose tools need confirmation (Windows, Linux, Mac)

Why: real servers such as Context7 declare all their tools read-only (`readOnlyHint: true`). Those tools never ask for confirmation, so they correctly have **no row** in Settings > Auto-approve rules. To test the rules table, the add / remove / import steps and the "Connected · N tools" status you need a server whose tools are **not** read-only. `scripts/manual-test-mcp-server.mjs` is one: three tools (`search_pages`, `list_pages`, `create_page`), none read-only, so all three get a row (`mcp__test_wiki__...`).

**The catch:** the script imports the MCP SDK and `zod` from `../node_modules/...`, relative to the script. Copied alone to a machine without the repo's `node_modules`, `node` fails with `ERR_MODULE_NOT_FOUND`, exits at once and Sachivji shows **Error: MCP error -32000: Connection closed**. Node itself must be installed (Sachivji's bundled Node is not on your PATH).

**Setup on a machine without the repo's `node_modules` (PowerShell shown; on Linux/Mac use `mkdir -p`, `cp`, forward slashes):**

```
mkdir C:\mcp-test\scripts
cd C:\mcp-test
npm init -y
npm install @modelcontextprotocol/sdk zod
copy <path to>\manual-test-mcp-server.mjs C:\mcp-test\scripts\
node scripts\manual-test-mcp-server.mjs
```

The last command should sit silently waiting for input (no error); stop it with Ctrl+C. `node_modules` next to `scripts` is what the imports expect.

**In Settings > MCP servers > Add MCP server:** name `test_wiki`, a one-line description, transport **Local (stdio)**, command `node`, arguments the full path of the script (`C:\mcp-test\scripts\manual-test-mcp-server.mjs`). Save.

**Expected:** status **Connected · 3 tools**; in Auto-approve rules, after **Refresh list**, three rows tagged **MCP server: test_wiki** (`mcp__test_wiki__search_pages`, `__list_pages`, `__create_page`), each with the "server did not mark this tool read-only" warning. Remove the server: the rows disappear (a ticked rule moves to the "not available now" table). Export, remove, Import: the server and its rows come back **without a restart** (this needs a build with fix #240).

**Troubleshooting:**

| Status line | Meaning |
|---|---|
| Error: MCP error -32000: Connection closed | `node` exited at start: wrong path, `node` not installed, or `ERR_MODULE_NOT_FOUND` (run the script by hand to see which) |
| Connected · 2 tools, no `mcp__` rows | the server is fine but its tools are read-only (e.g. Context7); nothing to confirm, no rule needed |
