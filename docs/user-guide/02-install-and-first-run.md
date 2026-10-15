# 2. Install and first run

## Download

Installers are published on the project's **GitHub Releases** page:

| System | File | Notes |
|---|---|---|
| Windows 11 (64-bit) | `Sachivji-Setup-<version>.exe` | Standard installer wizard |
| macOS (Apple Silicon) | `Sachivji-<version>-arm64.dmg` | Intel Macs are not supported yet |
| Linux (x64) | `Sachivji-<version>.AppImage` or `sachivji_<version>_amd64.deb` | Ubuntu 22.04 or newer (glibc 2.34 or newer) |

The installers include everything Sachivji needs to run its own scripts: a Python environment, a small local embedding server (Ollama) and Node.js. You do not install Python or Node yourself.

You need a network connection for your chosen AI provider. The first start also downloads a small embedding model (about 274 MB) and some Python packages once.

## The "unsigned app" warning

The installers are **not code-signed yet**, so your system shows a warning the first time. Nothing is wrong with the app.

- **Windows:** "Windows protected your PC" appears. Click **More info**, then **Run anyway**.
- **macOS:** the app is called "unidentified". Right-click (or Control-click) the app and choose **Open**, then confirm. The warning appears on the first launch only.
- **Linux:** no warning. For the `.deb`, install with your package manager (for example `sudo apt install ./sachivji_<version>_amd64.deb`).

## Installing on Windows

1. Run the installer and approve the Windows prompt that asks to allow the change.
2. When asked who the app is for, **Anyone who uses this computer** installs it under `Program Files\Sachivji`. This is the option tested most.
3. Finish the wizard. Leave **Run Sachivji** ticked to start it straight away, or open it later from the Start menu or the desktop shortcut.

## Installing on macOS

1. Open the `.dmg` and drag **Sachivji** to **Applications**.
2. Open it from Applications, using right-click, then **Open** the first time.

## Installing on Linux

- **AppImage:** make it executable (`chmod +x Sachivji-<version>.AppImage`) and run it.
- **.deb:** install it with your package manager, then start Sachivji from your application menu.
- Linux needs a running **secret-service keyring** (GNOME Keyring, KWallet or similar, with `libsecret` installed) to store keys securely. Most desktop installs have this. Without it, choose the file option described below.

## First-run screens

The first time you start Sachivji, a short setup runs.

1. **Where to keep secrets.** This chooses where API keys and connection passwords (databases, web services, MCP servers, email accounts) are stored.
   - **OS Keychain (recommended):** your operating system's own encrypted storage. Click **Continue with OS Keychain**.
   - **File instead:** a plain file on disk. Use it only when secure storage is not available on your machine. It is less secure, and the choice is permanent: you cannot switch back to the Keychain later.
2. **Python.** Sachivji sets up a Python environment inside your workspace for the scripts it writes (charts, Word and Excel files). If this step shows an error the first time, click **Retry**. If you do not want scripts at all, click **Continue without Python**. The assistant then works without running code, and you can turn Python on later in Settings.
3. **Local embeddings.** Sachivji starts its bundled Ollama server and downloads the `nomic-embed-text` model once. It powers the search over your past conversations. If the download fails, click **Retry** or **Continue anyway** and fix it later in Settings.

After these screens the main window opens. If a screen says it is still working, wait for it to finish before continuing.

## Your workspace

Sachivji keeps the files it creates in a **workspace** folder. The default is `Sachivji Workspace` inside your Documents folder. It contains these folders, created for you:

- `code` for scripts and source files
- `documents` for Word, Excel, PowerPoint, PDF and text files
- `resources` for images and other assets
- `venv`, the Python environment (do not edit it)

You can change the workspace in Settings.

## Next steps

Open **Settings** (click your name at the lower left, then **Settings**), add a key for one provider and pick a model. See [Providers and keys](03-providers-and-keys.md).

## Updating

The app checks for a newer version when it starts and shows a banner when one exists. It does not install updates silently. To update, download the new installer and run it over the old one. Your settings, keys, chats, workspace and connections are kept.

## Uninstalling

Uninstall Sachivji from your system's normal list of apps. To also remove all of your data, delete the app's data folder as well (on Windows `%APPDATA%\Sachivji`, on macOS `~/Library/Application Support/Sachivji`, on Linux `~/.config/Sachivji`), and the workspace folder if you no longer need the files. Deleting the data folder removes your chats, keys and settings, and the first-run screens appear again on the next start.
