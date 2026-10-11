# Windows installer: full cleanup / fresh-reinstall guide

Uninstalling Sachivji through Settings or Control Panel only removes the **program** — by
design (`electron-builder.yml` has no `deleteAppDataOnUninstall`, which defaults to `false`),
your chat history, provider keys, pulled embedding model, and workspace all survive an uninstall.
That is correct for a normal upgrade, but it means a plain uninstall is **not enough** to get a
genuinely clean slate (e.g. to re-test first-run onboarding, or to fully remove the app before
handing a machine back). This doc lists every location the installed app writes to and what to
do with each one.

## 1. Quit the app and check for orphan processes

Before touching anything, make sure nothing is still running. Task Manager → confirm none of
these remain:

- `Sachivji.exe`
- `ollama.exe` (the bundled local-embeddings runtime — killed on app quit via `before-quit`;
  if it's still there after a normal quit, that's itself worth reporting)
- `python.exe` / `pythonw.exe` (the managed workspace venv)
- `node.exe` (only runs transiently when an MCP server is launched via `npx`/`npm`; shouldn't
  outlive the app, but bundled starting with the Node-bundling fix, TASKS #202)

## 2. Uninstall the program

Either:

- **Settings → Apps → Installed apps → Sachivji → Uninstall**, or
- Start Menu → Sachivji folder → **Uninstall Sachivji** shortcut (present because the installer
  uses the standard NSIS wizard, not `oneClick` mode)

This removes, automatically, with no manual follow-up needed:

- The install directory (`C:\Program Files\Sachivji` for a per-machine/admin install, or
  `%LOCALAPPDATA%\Programs\sachivji` for a per-user install — which one you get depends on
  whether you chose "install for all users" and whether the account is an Administrator)
- The Desktop and Start Menu shortcuts
- The "Installed apps" / Control Panel entry itself

## 3. What the uninstaller deliberately leaves behind

These three locations are **never** touched by the uninstaller. Decide per location whether you
want to keep or wipe it — don't assume leftover data here is a bug.

| Location | What's in it | Wipe it if you want... |
| --- | --- | --- |
| `%APPDATA%\Sachivji` | `sachiv.db` (sessions, settings, `onboardingCompleted` flag), `credentials.enc.json` (encrypted provider/DB/MCP keys), `ollama-models\` (the pulled `nomic-embed-text` weights), `roles\` (user-defined role files), plus Electron's own Cache/Local Storage/IndexedDB/GPUCache | A fresh first run — onboarding (including the Local Embeddings step), the provider-key screen, and the empty-session state all come back only once this is gone |
| `%USERPROFILE%\.sachivji\.env` | Plaintext provider/connection keys — **only exists if you ever switched Secret Storage to "file" mode** in Settings (`#75`); the default keychain mode (Windows DPAPI) keeps everything inside `credentials.enc.json` above instead | A full security wipe, or you're done testing the file-storage mode and don't want plaintext keys left on disk |
| `Documents\Sachivji Workspace` (or `Documents\OneDrive\Documents\Sachivji Workspace` on an install that predates the OneDrive-redirection fix) | The Python `venv` (hundreds of MB), `tmp\` and `.sachiv-handoff\` scratch dirs, `.sachiv-clones\` (git clones made by the Developer role), `documents\`/`resources\`/`code\`/`templates\`, and anything you asked the app to create | A fresh Python-venv-creation test too (not just onboarding — the venv is independent of `onboardingCompleted`), or you just want the disk space back |

Deleting `%APPDATA%\Sachivji` and the workspace are independent choices — you can wipe one
without the other. Wiping `%APPDATA%\Sachivji` alone is enough for a fresh *onboarding* test;
the venv under the workspace gets reused either way unless you delete that too.

## 4. Full clean-slate checklist

For a genuinely fresh install (what onboarding/provider/Local-Embeddings testing needs):

1. Quit the app; confirm no orphan processes (step 1).
2. Uninstall (step 2).
3. Delete `%APPDATA%\Sachivji` entirely.
4. Delete `%USERPROFILE%\.sachivji\.env` if it exists (only relevant if file-mode secret storage
   was ever used).
5. Delete `Documents\Sachivji Workspace` if you also want a fresh venv/workspace test; otherwise
   leave it so the next install reuses the existing venv (faster).
6. Reinstall.

## 5. Partial cleanup (just replacing the build, keeping your data)

If you only want the newer build and don't care about a fresh onboarding test:

1. Quit the app.
2. Uninstall (step 2).
3. Reinstall the new build.

`%APPDATA%\Sachivji` and the workspace carry over untouched — your sessions, keys, and pulled
embedding model are all still there, and `onboardingCompleted` stays `true` so onboarding is
skipped, same as any normal upgrade.

## 6. Verifying cleanup worked

After step 4's full wipe, before reinstalling:

- `%LOCALAPPDATA%\Programs\sachivji` or `C:\Program Files\Sachivji` — gone
- Desktop / Start Menu shortcuts — gone
- `%APPDATA%\Sachivji` — gone (or recreated empty only once you relaunch)
- `Documents\Sachivji Workspace` — gone, if you chose to delete it
- Task Manager — no `Sachivji.exe` / `ollama.exe` / `python.exe` / `node.exe`

After reinstalling, onboarding should run from scratch, including the Local Embeddings step
doing a real network pull (not a no-op), and the provider list/first session should both be
populated immediately without needing a restart (TASKS #202 fix, commit `9deb0ab`).
