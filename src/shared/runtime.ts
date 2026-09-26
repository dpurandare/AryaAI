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
