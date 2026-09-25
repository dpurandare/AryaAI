import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * The workspace's Python virtual environment, hard-wired into `shell_execute`
 * rather than left to the model to find. Found live (the Northwind bar-chart
 * session): the workspace already had a working `venv/` (matplotlib, numpy,
 * pillow, python-docx — an agent had improvised it earlier) but nothing in
 * the app knew about it. The agent ran `python script.py`, got exit 127
 * ("python: not found" — the machine has only `python3`, and the system
 * Python has no matplotlib), concluded "Python is not available in this
 * environment", and never tried `python3` or `venv/bin/python`; the job
 * never ran end to end. Activating it in code, whenever it exists, removes
 * the decision from the model entirely.
 *
 * A venv isolates *packages*, not the filesystem — this is not a sandbox
 * (`shell_execute` can still read/write anywhere; its own description says so).
 */
export const WORKSPACE_VENV_DIR = 'venv'

export interface VenvOptions {
  platform?: NodeJS.Platform
  /** Injectable so the platform branches are unit-testable on any OS. */
  exists?: (p: string) => boolean
}

function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

/** The venv's executables folder (`bin`, or `Scripts` on Windows), only if it holds a runnable `python` — a stray empty `venv/` folder doesn't count. */
export function workspaceVenvBinDir(root: string, opts: VenvOptions = {}): string | undefined {
  const platform = opts.platform ?? process.platform
  const exists = opts.exists ?? existsSync
  const p = pathFor(platform)
  const bin = p.join(root, WORKSPACE_VENV_DIR, platform === 'win32' ? 'Scripts' : 'bin')
  return exists(p.join(bin, platform === 'win32' ? 'python.exe' : 'python')) ? bin : undefined
}

/**
 * `baseEnv` with the workspace venv activated (`VIRTUAL_ENV`, its bin folder
 * first on `PATH`, `PYTHONHOME` cleared as `activate` does), so plain `python`
 * and `pip` resolve to it. Returns `baseEnv` untouched, `active: false`, when
 * the workspace has no usable venv.
 */
export function withWorkspaceVenv(
  root: string,
  baseEnv: NodeJS.ProcessEnv,
  opts: VenvOptions = {}
): { env: NodeJS.ProcessEnv; active: boolean } {
  const bin = workspaceVenvBinDir(root, opts)
  if (!bin) return { env: baseEnv, active: false }
  const p = pathFor(opts.platform ?? process.platform)
  // Windows env keys are case-insensitive and usually spelled `Path`.
  const pathKey = Object.keys(baseEnv).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    VIRTUAL_ENV: p.join(root, WORKSPACE_VENV_DIR),
    [pathKey]: baseEnv[pathKey] ? `${bin}${p.delimiter}${baseEnv[pathKey]}` : bin
  }
  delete env.PYTHONHOME
  return { env, active: true }
}

/** True when a shell run looks like "the `python` command doesn't exist" (exit 127 on POSIX shells, 9009 on cmd.exe). */
export function looksLikePythonNotFound(exitCode: number, stderr: string): boolean {
  if (exitCode !== 127 && exitCode !== 9009) return false
  return /\bpython3?\b/i.test(stderr) && /not found|not recognized|no such file/i.test(stderr)
}

/** Appended to a python-not-found result when there is no workspace venv to fall back on, so the model bootstraps one instead of concluding it cannot run Python at all. */
export function pythonNotFoundHint(platform: NodeJS.Platform = process.platform): string {
  const create =
    platform === 'win32'
      ? 'py -m venv venv && venv\\Scripts\\pip install <packages>'
      : 'python3 -m venv venv && venv/bin/pip install <packages>'
  return (
    'hint: `python` is not on PATH here and this workspace has no usable `venv/` yet. Running Python IS possible — ' +
    `create the workspace venv once: \`${create}\` — after that \`python\` and \`pip\` automatically use it. ` +
    'For a stdlib-only script, `python3` may work directly.'
  )
}
