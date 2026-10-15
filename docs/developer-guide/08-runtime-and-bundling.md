# 8. Runtime and bundling

Sachivji runs agent-written scripts in Python, uses a local Ollama server for embeddings, and launches MCP servers through Node. The installers ship all three so a user needs nothing installed. This page covers the managed runtimes in the app (`src/main/runtime`) and the build-time fetch scripts that produce what is bundled.

## The managed Python runtime (`runtime/workspace-runtime.ts`)

Python is a prerequisite, and the workspace `venv` is created together with the workspace folders (design 4.3), not improvised by an agent mid-task.

- **`ensureWorkspace`** is idempotent and never destroys what it did not create: an existing venv is **adopted as is** (which is why a throwaway workspace matters in tests), a broken one is **reported, not rebuilt**, until the user asks for a **repair**, and a failed creation removes only the partial venv that same call made.
- **Interpreter.** A bundled interpreter when the packaged app ships one for the platform (`bundledPython`, found under `process.resourcesPath`), otherwise a probe of the system (`py -3`, `python`, `python3`). The minimum is 3.10 (`MIN_PYTHON`).
- **Base packages** (`BASE_PACKAGES`, pinned): `matplotlib`, `numpy`, `pillow`, `python-docx`, `openpyxl`. The pins are chosen so each supports the minimum Python. When a bundled **wheelhouse** exists, installation uses `--no-index --find-links <wheelhouse>`, so no network is needed.
- **Marker file** inside the venv records that this app created it and which packages it installed, so a later launch can tell "we created this and the packages never finished" from "the user brought their own venv".
- **Disk check** before creating (headroom for the venv and packages).
- **State machine** (`shared/runtime.ts`): `RuntimeStatus` is `missing-python`, `creating`, `ready`, `failed` or `disabled`; `RuntimePackages` is `none`, `installing`, `installed`, `failed` or `adopted`. The state is pushed to the UI as `RuntimeStateChanged`; Settings and first run offer **Retry**, **Repair** and **Turn Python off / on** (the last stored as a choice, so `python_run` can say "Python is turned off" instead of failing obscurely).
- `python_run` and `shell_execute` run with the venv active. `python-env.ts` builds the environment for them.
- `RuntimeDeps` abstracts the filesystem, process runs and free-space check, so the logic is unit-tested with a fake filesystem and a scripted runner on both platforms.

## The bundled Ollama (`runtime/ollama-runtime.ts`)

For local embeddings without a manual Ollama install.

- **`OllamaRuntime.ensure()`** picks a free port (11434 first, then 11435 to 11438), spawns the bundled `ollama serve` with `OLLAMA_HOST=127.0.0.1:<port>` and `OLLAMA_MODELS=<userData>/ollama-models`, waits for it to be healthy, **pulls `nomic-embed-text`** (the model is not bundled; about 274 MB over the network once), and recreates it from `models/ModelFileNomicEmbed` (shipped as a resource) to set the model's real trained context (`num_ctx 2048`). Status is `unavailable`, `starting`, `pulling-model` (with progress), `ready` or `failed`, pushed as `OllamaStateChanged`.
- It resolves to `unavailable` immediately when no bundled executable exists (a development run), so nothing changes there.
- `app.on('before-quit')` stops the server.
- **Routing caveat.** Once the server is healthy, `ipc/register.ts` calls `setBundledOllamaBaseUrl()` and every `ollama` provider instance (chat and embeddings) is pointed at it; because its models folder is the app's own, a user's own Ollama models are not reachable from an installer (TASKS #214).
- The spawn uses `stdio: 'ignore'`, so the server's own log is discarded. To see why it does not start, run the bundled binary by hand with `OLLAMA_HOST` and `OLLAMA_MODELS` set. (A missing writable home folder makes it fail at once: Ollama creates `~/.ollama` for its key.)

## MCP and bundled Node

`mcp/client.ts` prepends the bundled Node directory to the child's `PATH` for stdio servers (see [Data, APIs, MCP and email](07-data-api-mcp-email.md)).

## What is bundled, and how

Each platform ships **three runtimes plus a model file**, as electron-builder `extraResources` (`electron-builder.yml`), under the app's `resources/` folder:

| Platform | Python | Ollama | Node | Notes |
|---|---|---|---|---|
| Windows x64 | `python-win-x64` (+ `-wheels`) | `ollama-win-x64` | `node-win-x64` | The Node `node_modules` is listed separately, because electron-builder silently drops a path named `node_modules`. |
| macOS arm64 | `python-mac-arm64` (+ `-wheels`) | `ollama-mac-arm64` | `node-mac-arm64` | Apple Silicon only; Intel is deliberately deferred. |
| Linux x64 | `python-linux-x64` (+ `-wheels`) | `ollama-linux-x64` | `node-linux-x64` | Ubuntu 22.04 or newer. |

`ModelFileNomicEmbed` is shipped for every platform. Lookup code resolves a path under `process.resourcesPath` and returns `undefined` outside Electron, which is why every bundled-resource path is a no-op in dev and in unit tests.

Native modules are unpacked from the asar (`asarUnpack`: `**/*.node` and `sqlite-vec-*`); `db/index.ts` documents why the `sqlite-vec` loader needs its path redirected to `app.asar.unpacked`.

### Fetch scripts (`scripts/fetch-bundled-*`)

Nine scripts, one per runtime per platform, run through `npm run predist:<mac|win|linux>` (which `dist:*` relies on). They are plain Node with no project imports, safe to re-run (skipped unless `--force`), write only under the git-ignored `resources/`, and use `scripts/fetch-utils.mjs` to download a release asset and **verify it against a pinned sha256** before it is trusted.

- **Python:** a standalone `python-build-standalone` interpreter (pinned release tag, the same across platforms), plus the pinned base packages downloaded as prebuilt wheels for the target platform (`pip download` with `--platform`/`--python-version`) into the `-wheels` folder.
- **Ollama:** the official release for the platform. Windows and Linux are stripped to a minimal CPU set. macOS is kept deliberately conservative: only the unambiguously x86-only CPU libraries are removed, and both `mlx_metal_v3` and `mlx_metal_v4` stay (about 433 MB). A real run on an M5 showed the embedding model runs through the embedded Metal library and loads **neither** MLX folder, so they are probably removable for the embedding-only use, but that is not proven across chips (TASKS #208).
- **Node:** the official tarball, verified against that release's `SHASUMS256.txt`, extracted including npm's own `node_modules`.

Update a pin deliberately: re-verify the checksum from the upstream release, then run the three fetch scripts and a real app launch on that platform.

## Per-platform tests

None of this is exercised by unit tests against real runtimes. After changing a fetch script or the runtime code, build an unpacked app (`npx electron-builder --<platform> --dir --publish never`), launch it on a **throwaway profile**, and check Settings > Workspace: Python runtime **Ready**, Local embeddings **Ready**, and an `npx` MCP server connecting. `docs/manual_testing.md` has the per-platform checks, and `TASKS.md` #202, #207 and #208 record what was verified on each OS.
