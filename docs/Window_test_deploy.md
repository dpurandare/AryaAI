# Windows test deployment (build from source)

How to get the `design_change` branch running on a Windows 11 test machine without the installer. Three scripts do the work. The scripts have **not yet been run on Windows**; expect to fix small things on the first pass.

Works on Windows 11 x64 or ARM64. On ARM64 (for example a VMware VM on an Apple Silicon Mac) the scripts install the **x64** Python and Node on purpose. The app's pinned numpy and the `sqlite-vec` native module have no Windows ARM64 build, so the whole stack runs under Windows' x64 emulation. That is a good smoke test but not proof for a real AMD64 PC.

## Before you start

- Windows 11 with internet access and about 6 GB free disk.
- **winget** (it ships with Windows 11; if `winget` is not found, install "App Installer" from the Microsoft Store).
- A GitHub account that can read `dpurandare/AryaAI` (the repo is private).
- Copy **`scripts/windows-test-bootstrap.cmd`** to the machine (shared folder, email, or paste the text into a new file).

## 1. Install Git and clone the branch

Open a terminal in the folder where the clone should go (for example `%USERPROFILE%\Lab`) and run `windows-test-bootstrap.cmd` from there. It:

- installs Git and the GitHub CLI if they are missing,
- runs `gh auth login` (choose **Login with a web browser**, then enter the code in the browser),
- clones `design_change` into an `AryaAI` folder inside the folder you run it from (or pulls it if it is already there), then prints the next steps. Pass another folder as the first argument to change that.

## 2. Install the other prerequisites and create the embedding model

Open a **new** terminal and run `scripts\windows-test-prepare.cmd` from the clone. It:

- runs `scripts\install-prerequisites.ps1 -Ollama -Node -Yes`, which installs Python 3.12 (x64), Ollama, Node 24 through nvm-windows (this asks for administrator rights and opens a second window), and pulls `nomic-embed-text`,
- recreates the embedding model from `models\ModelFileNomicEmbed` (`ollama create nomic-embed-text -f models\ModelFileNomicEmbed`), so the context size matches what the model was trained for.

Read the summary the script prints. A yellow line is a warning, a red line is a failure. Running the script again is safe.

## 3. Build and start the app

Open a **new** terminal again (so Node is on `PATH`) and run:

```
scripts\windows-test-run.cmd
```

It prints the Node version and architecture, runs `npm ci` the first time, runs `npm run build`, then `npm start`. To take later changes: `scripts\windows-test-run.cmd update` does a `git pull`, reinstalls the dependencies, builds and starts.

## After it starts

- Add a provider key in **Settings**.
- Check **Settings > Runtime**. Python should become ready; the first start creates a virtual environment in `Documents\Sachivji Workspace\venv` and downloads packages once.
- If you use local search of past conversations, check that **Settings** shows `nomic-embed-text` available.
- Run through `docs/manual_testing.md` as usual, and note anything that is Windows specific.

## If something fails

| Symptom | Likely cause and fix |
| --- | --- |
| `winget` not found | Install "App Installer" from the Microsoft Store. |
| `git` or `node` not found right after installing | The terminal was opened before the install. Open a new one. |
| `gh auth login` cannot open a browser | Run `gh auth login --with-token` with a personal access token that can read the repo. |
| `npm ci` fails building `better-sqlite3` | It normally downloads a prebuilt binary. If it compiles instead, install the Visual Studio Build Tools (C++ workload) and run again. Tell me the output. |
| `Unsupported platform for sqlite-vec, on a win32-arm64 machine` | Electron was installed for ARM64 because Node was ARM64. Run `nvm install 24 64` and `nvm use 24 64` in an admin terminal, open a new terminal, then `scripts\windows-test-run.cmd fresh` (removes `node_modules` and reinstalls for x64). The run script now refuses to continue when `node -p "process.arch"` is not `x64`. |
| `ollama create` fails | Start Ollama from the Start menu and run `windows-test-prepare.cmd` again. |
