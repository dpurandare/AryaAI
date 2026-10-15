# 2. Getting started

## Prerequisites

- **Node.js 22 or newer** (developed and tested on Node 24 with npm 11; **not Node 20**: the prebuilt `better-sqlite3` binary crashes the process on Node 20).
- macOS, Windows 11 or Linux. On Linux, Ubuntu 22.04 or newer (glibc 2.34 or newer) is needed by the published `better-sqlite3` native addon.
- A C++ toolchain only if a native module has to be built from source (Xcode Command Line Tools, `build-essential`, or Visual Studio Build Tools).
- Python 3.10 to 3.13 with `venv` is used by the managed Python runtime during development (the packaged app bundles its own).
- Optional, only for the matching feature: `git`/`gh`, the `aws`/`az`/`gcloud` CLIs, a reachable Postgres/MySQL/SQL Server, and [Ollama](https://ollama.com) for local models.

On Windows, `scripts\install-prerequisites.cmd` installs and verifies most of this with winget (see `docs/prerequisites.md`).

## Install and run

```bash
npm install     # also downloads the Electron binary eagerly (postinstall)
npm run dev     # electron-vite dev server with hot reload for the renderer
```

`postinstall` runs `scripts/ensure-electron.mjs` (Electron 44+ downloads its binary lazily, which electron-vite does not expect) and `scripts/brand-electron-dev.mjs` (names the dev Electron "Sachivji" in the macOS menu bar and Dock).

Changes to the **renderer** hot-reload. Changes to **main** or **preload** restart the app.

Closing the window (or Cmd/Ctrl+Q) quits.

## The checks to run before you commit

```bash
npm run typecheck   # tsc for main/preload (tsconfig.node.json) + svelte-check for the renderer (tsconfig.web.json)
npm test            # the whole Vitest suite; mocked providers, no live API calls
npm run build       # electron-vite production build into out/
```

Run one test file with `npx vitest run src/main/tools/file-ops.test.ts`. The suite is about 1,600 tests and runs in seconds.

CI does not run on every push (it is manual-only, see [Build, release and CI](11-build-release-ci.md)). Run these three commands yourself.

## Running with a throwaway profile

The app stores everything under Electron's user-data folder (and keeps a workspace folder in Documents), so to test without touching your real data use a separate profile and workspace:

```bash
rm -rf /tmp/sachiv-fresh /tmp/sachiv-ws
SACHIV_WORKSPACE_DIR=/tmp/sachiv-ws npm run dev -- --user-data-dir=/tmp/sachiv-fresh
```

(`manual_testing.md` section 10 has the exact command for a built copy.) A workspace that already contains a `venv/` is adopted as it is and skips Python setup, which is why a throwaway workspace matters when testing first run.

For UI work, verify changes in a **running** copy rather than relying on type checks and unit tests: a throwaway Electron copy driven over the Chrome DevTools Protocol (`--remote-debugging-port`) is how the screenshot scripts work (see [Testing](10-testing.md)).

## Useful environment variables and flags

| Name | Effect |
|---|---|
| `SACHIV_WORKSPACE_DIR` | Overrides the default workspace folder (`Documents/Sachivji Workspace`). |
| `--user-data-dir=<dir>` | Electron flag: use this folder for the database, settings and secrets. |
| `SACHIV_USER_DATA` | Used by `scripts/with-app-key.cjs` to point at a different profile folder (the default is the Linux one). On macOS: `export SACHIV_USER_DATA="$HOME/Library/Application Support/Sachivji"`. |

## Helper scripts (`scripts/`)

| Script | Purpose |
|---|---|
| `with-app-key.cjs` | Runs a command with a provider key taken from the app's own secret store, never typed or logged; the key is redacted from the child's output. Needs `electron --no-sandbox scripts/with-app-key.cjs <provider> -- <command>`. |
| `routing-eval.mts` | Replays the role manifest's examples against a real provider with the router's real prompt and tool list (non-deterministic: run per model, a few times). Also the history replay probe. |
| `plan-probe.mts` | Measures how reliably a model returns a valid classify-and-plan reply, prompt-only versus provider-enforced structured output. |
| `cache-probe.mts` | Sends the same router request several times and prints time to first token and cached tokens. |
| `role-probe.mts` | Checks that each specialist, pinned in a conversation other roles answered in, answers as itself. |
| `manual-test-mcp-server.mjs` | A tiny stdio MCP server with a hostile, over-long tool description, for the manual test of untrusted text handling. |
| `generate_sample_db.py`, `validate_db.py` | Build and verify a sample wind and solar database for testing the data tools. |
| `fetch-bundled-{python,ollama,node}-{mac,win,linux}.mjs` | Download the per-platform runtimes that the installers bundle (see [Runtime and bundling](08-runtime-and-bundling.md)). |
| `windows-test-*.cmd`, `install-prerequisites.*` | Windows QA helpers (run the app from source in a VM; install prerequisites). |
| `fix-native-modules.sh` | Rebuilds `better-sqlite3` against this machine's Electron ABI (a Linux old-glibc workaround). |
| `export-docs.mjs`, `gen-tool-catalog.mjs`, `docs-screenshots.mjs` | Documentation tooling (see [Conventions](12-conventions.md)). |

The eval and probe scripts are run with `npx vite-node --config vitest.config.ts scripts/<name>.mts -- <provider> <model>`. They call real models and spend quota: ration them.

## Linux dev note

On newer distributions (Ubuntu 24.04 and others) that restrict unprivileged user namespaces, an unpackaged `npm run dev` can abort with "The SUID sandbox helper binary was found, but is not configured correctly". Fix once (and again after every `npm install` that re-downloads Electron):

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

The packaged AppImage and deb are not affected.
