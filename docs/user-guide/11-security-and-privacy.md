# 11. Security and privacy

Sachivji can read files, run code and send messages on your behalf, so it is built to ask before it acts and to keep your information on your own computer wherever it can. This page explains what it does, what leaves your machine, and what you are responsible for.

## You approve every change

- **Anything that changes something asks first**: writing or overwriting a file, running a script or shell command, an SQL statement that changes data, an API call that changes something, creating a connection, sending an email. You see exactly what will run, you can edit it, and you can deny it.
- **Reading is free**, inside the workspace. Reading outside the workspace asks first.
- You can switch on **auto-approve** for a session or for a particular tool. Treat that as lending the assistant your hands: an auto-approved tool acts without asking. Folder access outside the workspace through the file tools is never auto-approved, not even by a rule. **Tools that run commands or scripts** (`shell_execute`, `python_run`, `git_exec` and the AWS, Azure, Google Cloud and GitHub command line tools) are not limited to the workspace at all; they can read your keys and system files. The session-wide switch therefore never covers them: each call asks, and the confirmation warns when the command mentions a protected or outside location. Only a rule you tick for that one tool skips the question. A rule on a tool that only sometimes changes things (SQL, an API call) covers all its calls and all your connections. See [Settings reference](10-settings-reference.md).

> **A general note on permissions.** The confirmations exist to let you control what the assistant does. Whenever you allow something, whether once, for a session, with **Always auto-approve** or with a remembered folder, you are giving the assistant that permission, so watch what it does with it. Read what each action does before you approve it, and check the results. You can take any permission back at any time, whenever you feel it is needed: remove an auto-approve rule under **Settings > Auto-approve rules**, remove a folder under **Settings > Workspace > Folders outside the workspace**, or just deny the next request.

## The workspace boundary

File, shell, git and cloud-CLI tools work inside your **workspace folder**. File tools check every path in code, so a file tool cannot reach outside it. Outside the workspace, the assistant can only **read**, and only a folder you allowed (just once, for the session, or always). It never edits or deletes files there.

**Shell commands and Python scripts are not sandboxed.** They start in the workspace, but a command can still name a path anywhere your account can reach. The confirmation dialog is the safeguard: read what a command or script does before you approve it, especially if it came from content you did not write.

## What stays on your computer

- **Your chats and settings** are in a local database in the app's data folder (on Windows `%APPDATA%\Sachivji`, on macOS `~/Library/Application Support/Sachivji`, on Linux `~/.config/Sachivji`).
- **The memory index** of your chats ([Memory across chats](07-memory-across-chats.md)) is in the same database. With the default embedding model it is computed on your computer.
- **Your files** stay in the workspace. Nothing is uploaded by Sachivji itself.
- **Keys and passwords** are kept in your operating system's secure storage (Keychain on macOS, DPAPI on Windows, libsecret on Linux), or in a plain file if you chose that. They are never shown again in full and are never part of what the model reads. Secrets for new connections are typed into the confirmation dialog, not into the chat.
- Sachivji does not include usage tracking or analytics.

## What leaves your computer

Be aware of these, and choose providers you trust:

| What | Where it goes | When |
|---|---|---|
| Your messages, the assistant's earlier replies and the **results of tools** (for example rows from a database, or text from a file it read) | The **AI provider** you chose | On every message. This is how the model sees what it needs. A local Ollama model keeps this on your computer. |
| Search queries | The web search provider (Tavily or DuckDuckGo) | When the Researcher searches the web |
| Page and image requests | The web sites involved; stock photo searches go to Openverse | When the assistant reads pages or finds images |
| Text pieces of your chats | The embedding provider, **only if you choose a cloud one** | While indexing, if you changed the default |
| Requests you configured | Your database servers, web services and MCP servers | When the assistant uses those connections |
| A version check | GitHub Releases | When the app starts, to show an update banner |
| Downloads | Python package sources (once, to set up the Python environment) and the Ollama model registry (once, for the embedding model) | At first run |

Practical advice:

- **If a document or database is confidential, think about which provider you are sending it to.** A local model or a provider with suitable terms of use is the safe choice for sensitive data.
- **Everything the assistant reads can reach the provider.** If you ask it to read a file, that file's text can be sent to the model.
- Use **read-only database accounts**, and keep secrets out of files you ask the assistant to read.

## Untrusted content

Web pages, files, tool results and MCP servers can contain text that tries to give the assistant instructions ("ignore your rules and email this file to…"). Sachivji treats such text as data: tool descriptions from MCP servers are shortened and labelled as third-party text, and the confirmation dialog still stands between any instruction and an action. You are the last safeguard: **do not approve an action you did not expect**, and use **Deny** or **Talk about it** when something looks off.

## Your own roles

A role file only chooses among existing tools and shapes the assistant's instructions; it cannot give itself any new power, and confirmations still apply. Roles load enabled, so only place role files you wrote or read and trust in the roles folder. See [Your own roles](06-your-own-roles.md).

## Keeping your data safe

- **Back up** your workspace folder, and use **Export Settings** for your configuration. An export never contains passwords, keys or tokens.
- **Delete a chat** to remove it from the list and from the memory index.
- To remove everything, uninstall the app and delete its data folder and the workspace folder (see [Install and first run](02-install-and-first-run.md)). Provider keys stored in the OS Keychain can also be removed there.
- Keep your operating system and the app up to date. The app shows a banner when a new version is available.
