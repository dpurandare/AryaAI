# 11. Build, release and CI

## Build commands

| Command | What it does |
|---|---|
| `npm run build` | electron-vite production build into `out/` (main, preload, renderer: `index.html` and `print.html`). |
| `npm run predist:<mac\|win\|linux>` | Fetches the bundled Python, Ollama and Node for that platform into `resources/` (see [Runtime and bundling](08-runtime-and-bundling.md)). Runs automatically before `dist:*`. |
| `npm run dist:<mac\|win\|linux>` | `build`, then electron-builder, never publishing. Output in `release/`. |
| `npx electron-builder --mac --arm64 --dir --publish never` | A fast **unpacked** app (`release/mac-arm64/Sachivji.app`) for testing; no installer step. |
| `npm run icons:generate` | Regenerates icons from the source image. |

Targets (`electron-builder.yml`): **NSIS** installer on Windows (a normal wizard, per-user by default with a choice of install folder, desktop and Start menu shortcuts, "Run Sachivji" on finish), **DMG** (arm64 only) on macOS, **AppImage** and **deb** on Linux. `appId` stays `com.sachiv.app` despite the rename, because changing it would make the OS treat the app as a different one (update and keychain scoping).

Packaging details that have bitten before: native modules and `sqlite-vec` are unpacked from the asar (`asarUnpack`); electron-builder drops a path literally named `node_modules` from `extraResources`, so the bundled Node's npm modules are listed separately on Windows; the Linux `deb` lists its runtime dependencies (GTK, NSS, `libsecret-1-0`, …).

## Workflows (`.github/workflows/`)

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | **manual** (`workflow_dispatch`) | `npm ci`, typecheck, build, tests on macOS, Windows and Ubuntu. It no longer runs on push or pull request (a decision made so routine pushes do not start CI). |
| `release.yml` | push of a `v*` tag | First creates one empty **draft** release (so the three platform jobs share it), then builds all three platforms. Each job runs its `predist:<os>` script first, because `release.yml` calls `electron-builder` directly and `predist` only runs automatically for `npm run dist:*`; without it the bundled runtimes are silently missing. Publishes with `--publish always`. The Windows job then re-zips the installer, uploads the `.zip` and deletes the bare `.exe` and its blockmap, because browsers block unsigned `.exe` downloads. |
| `windows-dist.yml`, `linux-dist.yml`, `macos-dist.yml` | manual | Build one platform's installer and upload it as an **artifact** (kept 14 days) for testing on a clean machine, without a tag or release. |

Artifact storage counts against the repository's quota, so delete old installer artifacts and run records when they pile up.

## Versioning

Semantic Versioning. While the major version is `0`, any release may include breaking changes. The plan: **bug fixes in 0.3.x patch releases, larger features in 0.4.0**. The version lives in `package.json` (and the lockfile) and, as the client identity the app announces to MCP servers, in `src/main/mcp/client.ts` (`new Client({ name: 'sachiv', version })`). Keep the three in step.

## Cutting a release

1. Make sure `main` is what you want to ship, and **run CI manually** on it (all three platforms green).
2. Run the relevant checks from `docs/manual_testing.md` on the platforms you can (and, for the bundled runtimes, a clean profile).
3. Bump the version in `package.json`, `package-lock.json` and `src/main/mcp/client.ts`.
4. Move the `docs/CHANGELOG.md` `[Unreleased]` entries under the new version heading, with the date.
5. Commit, then tag: `git tag vX.Y.Z && git push origin vX.Y.Z`. The tag triggers `release.yml`, which builds every platform and fills a **draft** release with the installers (Windows as a `.zip`) and the update metadata (`latest*.yml`).
6. Test a downloaded installer, then publish the draft by hand. The update check reads the published release, so a draft never reaches users.

Old unpublished draft releases from earlier versions may remain; do not publish them.

## Updates

`src/main/updater.ts` (packaged builds only) checks GitHub Releases on start and tells the renderer about a newer version, which shows a banner linking to the release. It does not download or install silently, because the builds are unsigned.

## Signing (not done yet)

Builds are **not code-signed**. Windows shows SmartScreen's "Windows protected your PC" and macOS Gatekeeper's "unidentified developer" the first time. `electron-builder.yml` states the macOS side explicitly (`identity: null`, `notarize: false`). Signing needs credentials the project does not have yet (an Apple Developer ID and notarization profile, a Windows Authenticode certificate); the work is tracked in `TASKS.md` #11 and #63 to #66. When they exist, wire them into `electron-builder.yml` and `release.yml` (secrets in the repository settings), and re-test the install flow on clean machines.

## Platform notes

- **Windows:** test on a real x64 machine when possible; an ARM64 VM runs x64 under emulation and is only a smoke test. `scripts/windows-test-*.cmd` build and run from source in a VM. OneDrive's Documents redirection is avoided for the default workspace.
- **macOS:** Apple Silicon only. See the Ollama notes in [Runtime and bundling](08-runtime-and-bundling.md).
- **Linux:** Ubuntu 22.04 or newer (glibc 2.34); needs a secret-service keyring for the secure key store.
