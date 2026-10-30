# Manual test plan: Sachivji 0.4.0

For Deepak. Started 2026-10-30 on the `release/0.4.0` branch. The general regression list stays in `docs/manual_testing.md`; this document covers only what 0.4.0 changes, with exact steps. Each item gets a section as it is finished; the builds to test, the results table and the smoke tests are added when the installers are built (CI first, then installers, per `docs/release_process.md`). Mark **Pass / Fail / Odd** per ID in the Results table; the sponsor gets nothing until you publish.

Test IDs here start with the TASKS number of the item (for example **214-1**).

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
