# Manual test plan: Sachivji 0.4.0

For Deepak. Started 2026-10-30 on the `release/0.4.0` branch. The general regression list stays in `docs/manual_testing.md`; this document covers only what 0.4.0 changes, with exact steps. Each item gets a section as it is finished; the builds to test, the results table and the smoke tests are added when the installers are built (CI first, then installers, per `docs/release_process.md`). Mark **Pass / Fail / Odd** per ID in the Results table; the sponsor gets nothing until you publish.

Test IDs here start with the TASKS number of the item (for example **214-1**).

## The builds to test

Built from commit `ec770a5` on `release/0.4.0` (version 0.4.0; CI green on Windows, macOS and Linux, run [41081530745](https://github.com/dpurandare/AryaAI/actions/runs/41081530745)) on 2026-10-30, after all ten items were coded and the whole-branch review fixes were applied. **These expire on 2026-11-13** (14 days); if a fix is made, the installers are rebuilt and these links are replaced. Downloading needs a GitHub login with access to the repository. Nothing is published: the sponsor gets a build only when you publish the draft release.

| OS | Artifact (zip containing the installer) | Size | Run |
|---|---|---|---|
| Windows | [sachivji-windows-installer](https://github.com/dpurandare/AryaAI/actions/runs/41082172227/artifacts/12989862908) | 273 MB | [41082172227](https://github.com/dpurandare/AryaAI/actions/runs/41082172227) |
| macOS (Apple Silicon) | [sachivji-macos-installer](https://github.com/dpurandare/AryaAI/actions/runs/41082176544/artifacts/12990212206) | 490 MB | [41082176544](https://github.com/dpurandare/AryaAI/actions/runs/41082176544) |
| Linux | [sachivji-linux-installer](https://github.com/dpurandare/AryaAI/actions/runs/41082181312/artifacts/12990017401) | 678 MB | [41082181312](https://github.com/dpurandare/AryaAI/actions/runs/41082181312) |

From a terminal instead (GitHub CLI, signed in): `gh run download 41082172227 -R dpurandare/AryaAI -n sachivji-windows-installer` (use `41082176544` / `sachivji-macos-installer` and `41082181312` / `sachivji-linux-installer` for the others). Install over 0.3.2 (the upgrade keeps settings and chats); the workspace gets the new folders `data/`, `downloads/` and `exports/` at first start.

**Which machine tests what.** Linux: everything. Windows VM: 214-7 (netstat), 229-5 (Explorer drop), 169-2, 216, 228 and the upgrade over 0.3.2. Mac: 229, 216 (the picker), 214 (Ollama as a Mac app). Ubuntu 20.04 is not supported (the app does not start there). Items needing a hosted key: 225 (fallback), 168-1 (Ollama Cloud, skip without a key), 242-1 (`gpt-4o-mini`).

## #214 Ollama: embeddings-only bundled server, your own Ollama for chat

What changed: the Ollama that comes with the installers serves only the search embeddings, on its own port (11450 to 11455, never 11434). "Ollama (local)" chat uses **your own** Ollama (address in Settings, default `http://localhost:11434`) and is hidden from the model selection while Ollama is not running.

| ID | Where | Steps | Expect |
|---|---|---|---|
| **214-1** | Any OS, an installer build, your own Ollama running with at least one model | Open the model selection (provider/model text in the status bar). | "Ollama (local)" is in the provider list and lists **your** models (not only `nomic-embed-text`). |
| **214-2** | Same | Quit your Ollama (Linux/macOS: stop the service or `pkill ollama`; Windows: quit the tray icon). Wait up to 15 seconds, open the model selection again. | "Ollama (local)" has disappeared from the provider list (if it was the active provider it stays, labelled "(not running)", and the model box says why). |
| **214-3** | Same | With Ollama still stopped and "Ollama (local)" active, send a message. | A plain error: "Ollama (local) is not running at http://localhost:11434. Start Ollama, or correct its address in Settings…". Nothing switches to another model. |
| **214-4** | Same | Settings > **Ollama (local chat)**. | A red line says what is wrong, with install help (ollama.com/download, `ollama pull <model>`). Start Ollama again: within about 10 seconds the line turns green ("Ollama is running at …"), and "Ollama (local)" is back in the model selection without restarting Sachivji. |
| **214-5** | Same | Enter a wrong address (for example `http://localhost:11499`), **Save**. Then clear the field, **Save**. | Wrong address: red line "Could not connect to …". Empty: back to `http://localhost:11434`, green again. |
| **214-6** | Two machines, or one with Ollama listening on a network address | Enter the other machine's address (for example `http://192.168.1.20:11434`), **Save**. | Green; its models are listed in the model selection. |
| **214-7** | Linux/Mac: `ss -ltn \| grep 114` or `lsof -iTCP -sTCP:LISTEN \| grep -i ollama`; Windows: `netstat -ano \| findstr 114` | With your own Ollama running, start Sachivji. | Your Ollama holds 11434; Sachivji's bundled one is on 11450 (or the next free port up to 11455), never 11434. |
| **214-8** | Installer build, search over past chats | Settings > Search history shows the status; ask for something from an earlier chat ("search my history for …"). | Search still works; the index status is ready and no rebuild is requested. |
| **214-9** | Clean machine or after deleting the app data folder (first run) | First run, step "Local embeddings". | The embedding model downloads and the step turns Ready (the bundled server is on its new port). |

## #224 Search index notices a changed embedding model

What changed: the app remembers which weights of `nomic-embed-text` built the search index. If the model keeps its name but its contents change (reinstall, newer Ollama), the index asks for a rebuild instead of silently searching worse.

| ID | Where | Steps | Expect |
|---|---|---|---|
| **224-1** | Any OS, an installer build with some chats already indexed (Settings > Search history shows "N / N messages indexed") | Update to this build and restart. | Still "N / N messages indexed": an existing index is **not** flagged (it adopts the current model as its baseline). Search for something from an old chat still works. |
| **224-2** | Same, with your own Ollama as the embedding provider (Settings > Search history) | Replace the model's contents under the same name: stop using the old one with `ollama rm nomic-embed-text`, then `ollama pull nomic-embed-text` only if the newer version differs, or create a different model under that name (`ollama cp nomic-embed-text:latest backup`, then `ollama create nomic-embed-text -f <a Modelfile with FROM mxbai-embed-large>`); restart Sachivji. | A banner at the top says searching past chats needs a rebuild (Go to Settings opens Settings; × hides it until the next start). Settings > Search history says the embedding model was updated or reinstalled and needs a rebuild; asking the assistant to search past chats says the same; new messages are not added. **Rebuild index** fixes it. (Hard to trigger by hand: if you cannot, mark N/A, it is covered by automated tests.) |

## #225 Hosted fallback model when Ollama (local) is not running

What changed: optionally, a hosted model answers a message when "Ollama (local)" is your chat model and Ollama is not running. Needs a provider that has an API key, a model, and a tick box (consent). The chat always shows a line, and the active provider is never changed.

| ID | Where | Steps | Expect |
|---|---|---|---|
| **225-1** | Any OS | Settings > Ollama (local chat) > **If Ollama is not running**: pick a hosted provider (for example Anthropic) and a model (`claude-haiku-5-5`). Do **not** tick the box. **Save**. | The provider list only shows providers that already have a key; "Saved. The fallback is off (it needs a provider, a model and the tick box)." |
| **225-2** | Same | Tick the box (the text names the provider), **Save**. | "Saved. Anthropic claude-haiku-5-5 will answer when Ollama is not running." |
| **225-3** | Ollama (local) is the active provider; stop Ollama | Wait up to 15 seconds and look at the status bar. | It reads `Anthropic · claude-haiku-5-5 · fallback for Ollama (local)` (not "(not running)"). |
| **225-4** | Same | Send "Say hello in five words." | A warning line appears right after your message: "Ollama (local) is not running, so this answer came from Anthropic claude-haiku-5-5. Your conversation was sent to Anthropic." Then the answer. Quit and reopen: the line is still in that chat. Start Ollama again: the next message goes to Ollama (status bar back to Ollama, no warning). |
| **225-5** | Same, Ollama stopped | Untick the box (or choose "No fallback"), **Save**, send a message. | The status bar says "Ollama (local) (not running)"; the send fails with the plain "Ollama (local) is not running at …" message. Nothing is sent to the hosted provider. |

## #168 Ollama Cloud usage is not shown as $0

| ID | Where | Steps | Expect |
|---|---|---|---|
| **168-1** | Needs an Ollama Cloud key (skip if you have none) | Provider **Ollama Cloud**, model `gemma4:cloud` (or any `:cloud` model), send a message. | The meter at the bottom shows tokens (`Σ …`) but **no** `~$` cost (unknown), not `~$0.00`. |
| **168-2** | Own Ollama with a local model | Provider **Ollama (local)**, any local model, send a message. | The meter shows `~$0.00` or no cost as before (local = free); the context window figure is unchanged. |

## #228 One table decides where generated files go

| ID | Where | Steps | Expect |
|---|---|---|---|
| **228-1** | Any OS, an existing workspace | Start the build, then look in the workspace folder. | New empty folders `data/`, `downloads/` and `exports/` exist next to `code/`, `documents/`, `resources/`. Nothing of yours moved. |
| **228-2** | Any model | "Save the text `meeting notes` in a file called notes.md." then "Save the lines `a,b` and `1,2` as sales.csv." then "Save {\"x\": 1} as answer.json." | `documents/notes.md`, `data/sales.csv`, `data/answer.json`; the replies give those paths (not the bare names). |
| **228-3** | Any model | "Create a folder myapp with a README.md and a package.json containing {} inside it." | `myapp/README.md` and `myapp/package.json` stay in `myapp/` (not split into documents/ and data/). |
| **228-4** | Developer role | "Write a Python script that saves a list of 3 numbers to numbers.json and a table to table.csv in the current folder, then run it." (bare names in the script) | After the run the root has no loose `numbers.json` or `table.csv` only if four or more files were scattered; with just these two they stay where the script wrote them (the existing rule: one or two requested outputs stay). Mark Pass if that matches. |

## #229 Drag a file into the chat to add its path

| ID | Where | Steps | Expect |
|---|---|---|---|
| **229-1** | Every OS | Drag a file (for example a PDF or a text file with a space in its name) from the file manager over the message box. | The box shows a coloured outline while you hold the file over it. |
| **229-2** | Same | Drop it. | The file's **full path** is in the message box (in quotes if it has spaces), not its contents. Type "Summarise this" after it and send: the assistant asks permission to read a file outside the workspace (once per folder) and then reads it. |
| **229-3** | Same | Drop two files at once, then one more later. | One path per line; the later one is added after what is already typed. |
| **229-4** | Same | Drop a file on the chat transcript or the sidebar (not the message box). | Nothing happens and the app does not change to show the file. While a turn is running, a drop on the message box goes into the steering note. |
| **229-5** | Windows | Drop a file from Explorer. | The path is a Windows path (`C:\Users\…`), quoted if it has spaces. |

## #216 Allow a folder outside the workspace in advance

| ID | Where | Steps | Expect |
|---|---|---|---|
| **216-1** | Every OS | Settings > Folders outside the workspace > **Add folder…**, pick a folder (for example Downloads). | The native folder picker opens; the folder is listed straight away. Ask the assistant "List the files in <that folder>": no permission prompt, it works. |
| **216-2** | Same | Click **Add Documents** (a suggestion button). Then look at the buttons. | Documents is listed and its button is gone. |
| **216-3** | Same | **Add folder…** and pick your home folder; then `.ssh` (or `.aws`) inside it; then a folder inside one already listed. | Home: refused as too broad. `.ssh`: refused as protected. A subfolder of a listed one: "already covered by …". Nothing is added in any of the three. |
| **216-4** | Same | **Remove** a listed folder, ask the assistant to read a file in it. | Prompted again, as before. |

## #169 Search inside files (`find_in_files`)

| ID | Where | Steps | Expect |
|---|---|---|---|
| **169-1** | Developer role (pin it), any OS, a workspace with some code or text files | "Which files in the workspace mention the word `import`? Use find_in_files." | A list of `file` then indented `line: text` matches, a count line ("N match(es) in M file(s) … searched K file(s)"); no `.png`/`.docx` in it. |
| **169-2** | Windows especially | "Find every TODO in my code and show one line of context." | Works on Windows with no `grep` installed; context lines are shown with a `-` after the line number. |
| **169-3** | A workspace with a file whose word appears more than 5 times | "Search for `the` in documents/." | At most 5 matches per file shown, with "(N more match(es) in this file not shown)"; with many files "stopped after 30 files…, narrow the path, glob or pattern". The assistant narrows the search instead of claiming that is all. |
| **169-4** | Auto mode | "Search my notes for the word budget." | The router hands the search to the Developer (or reads the files itself); either way no error about a missing tool. |

## #238 Overview of the workspace in one call

| ID | Where | Steps | Expect |
|---|---|---|---|
| **238-1** | Any model | "What is in my workspace? List the folders and what is inside them." | One `list_directory` call with depth 2 or 3 (see the tool calls with Ctrl+O / Cmd+O); the reply names the real subfolders and files, not only the top level, and does not invent a `templates/` that is not there. |
| **238-2** | A workspace with `venv/` and `tmp/` | Same question. | `venv`, `tmp` (and `node_modules`, `.git` if present) are named as folders but their contents are not listed; the reply may say they were not opened. No `.sachiv-handoff`. |
| **238-3** | A workspace with a folder of 200+ files | "List everything under documents/ with depth 2." | The list stops at 200 entries and says how many more there are; the assistant offers to list a subfolder. |

## #242 Greeting of a pinned specialist enforced in code

| ID | Where | Steps | Expect |
|---|---|---|---|
| **242-1** | `gpt-4o-mini` (and any other model), each specialist pinned in a NEW chat | `Hello`, then `What can you do?` (as R1 / T10 in the 0.3.2 test doc). | The reply to `Hello`: the menu name, what it does, **its tools named** ("My tools: …" at the end if the model forgot), and **no** "How can I assist you today?". The reply to `What can you do?` is fuller and also names the specialist and its tools. The reply appears all at once rather than word by word. |
| **242-2** | Same | Pin a specialist and send a real request such as `Compare Python and Rust in two sentences.` | A normal answer; no introduction, nothing appended or removed. |

## Results

| ID | Item | Pass / Fail / Odd | Model / OS | Notes |
|---|---|---|---|---|
| 214-1 | Own models listed | | | |
| 214-2 | Hidden when Ollama stops | | | |
| 214-3 | Plain error on send | | | |
| 214-4 | Settings status, auto recovery | | | |
| 214-5 | Wrong / empty address | | | |
| 214-6 | Ollama on the network | | | |
| 214-7 | Bundled port never 11434 | | | |
| 214-8 | Search history still works | | | |
| 214-9 | First run embeddings | | | |
| 224-1 | Existing index not flagged after upgrade | | | |
| 224-2 | Changed model flagged, rebuild fixes | | | |
| 225-1 | Fallback choices limited to providers with a key; off without the tick | | | |
| 225-2 | Fallback saved with consent | | | |
| 225-3 | Status bar shows the fallback model | | | |
| 225-4 | Warning line kept in the chat; back to Ollama when it returns | | | |
| 225-5 | No fallback = plain error, nothing sent | | | |
| 168-1 | Ollama Cloud shows no $0 | | | |
| 168-2 | Local Ollama unchanged | | | |
| 228-1 | New folders created, nothing moved | | | |
| 228-2 | Bare .md/.csv/.json filed by type | | | |
| 228-3 | Project files with a folder stay together | | | |
| 228-4 | Script outputs (existing rule unchanged) | | | |
| 229-1 | Drop target outline | | | |
| 229-2 | Full path inserted; assistant reads it | | | |
| 229-3 | Several files, appended | | | |
| 229-4 | Drop elsewhere does nothing; steering note | | | |
| 229-5 | Windows path | | | |
| 216-1 | Add folder via picker, no prompt afterwards | | | |
| 216-2 | Suggestion buttons | | | |
| 216-3 | Home / protected / covered refused | | | |
| 216-4 | Remove restores the prompt | | | |
| 169-1 | Matches listed with file and line, binary skipped | | | |
| 169-2 | Works on Windows, context lines | | | |
| 169-3 | Caps stated honestly | | | |
| 169-4 | Reachable in Auto mode | | | |
| 238-1 | Overview in one call | | | |
| 238-2 | Noise folders not opened | | | |
| 238-3 | Long list capped and stated | | | |
| 242-1 | Greeting complete on every specialist | | | |
| 242-2 | Real requests untouched | | | |
