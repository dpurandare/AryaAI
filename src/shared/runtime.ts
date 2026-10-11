/**
 * State of the workspace's managed Python runtime (`<workspace>/venv`).
 * See design-discussion.md section 4.3 — Python is a prerequisite and the venv
 * is created together with the workspace folders, not improvised by an agent.
 */
export type RuntimeStatus =
  /** No usable system Python found (or too old / missing `venv`/`ensurepip`). */
  | 'missing-python'
  /** Creating the venv (and then installing base packages). */
  | 'creating'
  /** `<workspace>/venv` exists and its interpreter runs. */
  | 'ready'
  /** Creation failed, or an existing venv is broken. Retry / Repair applies. */
  | 'failed'
  /** The user chose to continue without Python; code execution is unavailable. */
  | 'disabled'

export type RuntimePackages =
  /** Nothing to report (no venv, or still being created). */
  | 'none'
  | 'installing'
  | 'installed'
  | 'failed'
  /** An existing venv was adopted as-is; its packages are not managed. */
  | 'adopted'

export interface RuntimeState {
  status: RuntimeStatus
  packages: RuntimePackages
  /** Human-readable, shown in Settings and onboarding. Always set. */
  message: string
  /** The interpreter's `major.minor.patch`, when known. */
  pythonVersion?: string
  /** Workspace root this state describes. */
  root: string
}

/**
 * State of the bundled, CPU-only Ollama runtime shipped with the Windows sponsor build
 * (TASKS #202) — ships only on win32 builds that bundled it; `'unavailable'` on every other
 * build (dev, mac, linux, or a win32 build without the resource), so this is a strict no-op
 * everywhere else and the user's own "bring your own Ollama" setup is never touched.
 */
export type OllamaRuntimeStatus =
  /** Not a win32 build with the bundled resource present — nothing to do here. */
  | 'unavailable'
  /** Spawning `ollama.exe serve` and waiting for its health check. */
  | 'starting'
  /** Server is healthy; pulling the embedding model over the network (not bundled — see TASKS #202). */
  | 'pulling-model'
  /** Server healthy and the embedding model present — ready for `embed()` calls. */
  | 'ready'
  /** Spawn, health check, or the model pull failed. Retry applies. */
  | 'failed'

export interface OllamaRuntimeState {
  status: OllamaRuntimeStatus
  /** Human-readable, shown in Settings and onboarding. Always set. */
  message: string
  /** `http://127.0.0.1:<port>` once the server is confirmed healthy — the port the bundled
   * server actually bound (not always the default 11434: picked to avoid colliding with an
   * Ollama the sponsor already runs for their own purposes). */
  baseUrl?: string
  /** Set while status is `'pulling-model'`; omitted once the pull finishes either way. */
  modelPullProgress?: { completed: number; total: number }
}
