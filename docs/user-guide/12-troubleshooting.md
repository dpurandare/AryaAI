# 12. Troubleshooting

Find the symptom, then try the fix. Sachivji does not keep a log file yet, so when you report a problem, write down what you did, the exact message shown, your operating system and the app version (shown in the status bar and in **About**).

## Starting and first run

| Symptom | What to do |
|---|---|
| **Windows: "Windows protected your PC"** | The installer is not code-signed yet. Click **More info**, then **Run anyway**. |
| **macOS: the app is "unidentified" or will not open** | Right-click (or Control-click) the app, choose **Open**, and confirm. You only need to do this once. |
| **First-run Python step shows an error** | Click **Retry**. The first check can run before Python is configured; retrying finds it. If it keeps failing, click **Continue without Python** and fix it later in **Settings > Workspace** (Python runtime). |
| **First-run embeddings step shows an error** | The embedding model could not be downloaded (it needs a network connection once). Click **Retry**, or **Continue anyway**; chat works without it, but memory across chats does not. Fix it later in Settings and click **Rebuild index** (see [Memory across chats](07-memory-across-chats.md)). |
| **After first run the provider list or first chat looks empty** | Close and reopen the app. Your settings were saved. If it persists, check **Settings > Provider API keys**. |
| **Linux: "OS-native secure storage is not available"** | Saving a key needs a running secret-service keyring (GNOME Keyring, KWallet or similar, with `libsecret`). Start one, or choose the file option at first run (this is permanent). |

## Keys, providers and models

| Symptom | What to do |
|---|---|
| **"Key rejected"** | Check that you pasted the whole key, with no spaces, and that it belongs to the provider you selected. |
| **"No model set" in the status bar** | Click the provider and model button and choose a model. |
| **An error about rate limits, quota or credits** | The provider is refusing more requests for now. Wait, switch model or provider, or check your plan. Free tiers are the usual cause. |
| **Anthropic fails with an error mentioning `cache_control`** | Turn off **Prompt caching** in Settings. |
| **A model list does not load** | The provider may need a key first, or your network blocks it. You can type a model name by hand. |
| **Replies are slow** | Turn off **Plan complex requests before acting**, or use a faster model. |

## Local (Ollama) models

| Symptom | What to do |
|---|---|
| **Ollama (local) does not respond, or lists no chat models** | In the installers, "Ollama (local)" currently uses the small Ollama that comes with Sachivji (it only holds the embedding model), not your own Ollama, so your own models are not available there yet. When running from source, make sure Ollama is running and the model has been pulled. |
| **A local model forgets things and the context meter shows a very small number (often about 4K)** | Ollama loads models with a small context window by default, whatever the model advertises. Create a custom model with a larger context (`num_ctx`) in an Ollama Modelfile and select that custom model instead. |
| **A small local model ignores instructions or loops** | Local models vary a lot. Try a larger one, pin the right specialist, or ask for one small step at a time. |

## The assistant is not doing what you want

| Symptom | What to do |
|---|---|
| **It keeps trying the same thing** | Press **Stop**, then rephrase with the exact file, connection or tool, or add a note while it runs. If it asks "continue or stop", choose **Stop here** when it is not making progress. |
| **The wrong specialist answered** | Say which one you meant, or pin it with the Agent selector (see [Agents and roles](05-agents-and-roles.md)). |
| **It answered from memory instead of using your database, files or MCP server** | Name the connection or file in your request, for example "using the Northwind database". |
| **A reply is cut off or incomplete** | Ask it to continue, or switch to a larger model. |
| **It says it cannot do something** | Check the [Tool catalog](appendix-tool-catalog.md); some things are not supported yet (for example reading PDFs). |
| **A role of mine is never used** | Check its summary and examples ([Your own roles](06-your-own-roles.md)), or pin it. |

## Files, documents and Python

| Symptom | What to do |
|---|---|
| **A script or chart fails because Python is off or broken** | **Settings > Workspace > Python runtime**: **Retry**, then **Repair…**, or **Turn Python on**. |
| **Python environment is older than expected** | Click **Repair…** in the Python runtime section. |
| **A generated Word or PowerPoint file looks wrong** | Open the file and check it; ask for a correction with specifics. Existing files cannot be edited in place; the assistant creates a new one or fills a template. |
| **A file is not found** | Say where it is. Files in the workspace are found without asking; others need your permission to read. |
| **The assistant asks again and again for the same folder** | Choose **For this session** or **Always** in the folder-access prompt (the default is "Just this once"). |

## Connections

| Symptom | What to do |
|---|---|
| **A database or API connection fails its test** | Check the host, port, database name, credentials and that the server is reachable from this computer. Use a read-only account. |
| **An MCP server shows an error or "Connection closed"** | Click **Reconnect**. For a local server, check the command and arguments (for example `npx` and the package name). A server needs a network connection if it downloads its package. |
| **The assistant never uses an MCP server** | Write a clear one-line description in the server's settings and name the server in your request. |
| **Email will not send** | For Gmail use an **app password**, not your normal password. For other servers check the host and port (587 STARTTLS, 465 TLS). For now Gmail is the supported choice; providers that need OAuth 2 are handled case by case (see [Connecting data and services](09-connecting-data-and-services.md#email-accounts)). |

## Memory across chats

See the table in [Memory across chats](07-memory-across-chats.md).

## Starting fresh

To test a clean start (for example to see the first-run screens again), quit the app and delete its data folder: on Windows `%APPDATA%\Sachivji`, on macOS `~/Library/Application Support/Sachivji`, on Linux `~/.config/Sachivji`. This removes your chats, settings and stored keys. Delete the workspace folder too (`Sachivji Workspace` in Documents) if you also want a fresh Python environment. **Export Settings** first if you want to keep your configuration.

## Installing and updating

- **Update:** download the new installer and run it over the old version. Your data is kept.
- **Uninstall:** use your system's normal list of apps (see [Install and first run](02-install-and-first-run.md)).
- On Windows, also check Task Manager after quitting: no `Sachivji.exe`, `ollama.exe`, `python.exe` or `node.exe` should be left running.
