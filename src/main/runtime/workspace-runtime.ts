import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeState } from '@shared/runtime'
import { WORKSPACE_VENV_DIR, workspaceVenvBinDir } from '../tools/python-env'
import { WORKSPACE_FOLDERS } from '../tools/workspace-layout'

/**
 * The managed workspace runtime (design-discussion.md section 4.3): Python is a
 * prerequisite, and the workspace venv is created together with the workspace
 * folders instead of being improvised by an agent mid-task.
 *
 * `ensureWorkspace` is idempotent and never destroys content it did not
 * create: an existing venv is adopted as-is, a broken one is reported (not
 * rebuilt) until the user asks for a repair, and a failed creation only
 * removes the partial venv this same call just made.
 */

/** Oldest Python the pinned base packages support (verified against PyPI's `requires_python`, 2026-09-26). */
export const MIN_PYTHON = { major: 3, minor: 10 } as const

/**
 * Curated, pinned base packages installed into a freshly created venv — the
 * common "make a chart / Word / Excel file" toolkit. Pins are chosen so that
 * every one of them supports MIN_PYTHON: newer numpy (2.5) and matplotlib
 * (3.11) need Python 3.12/3.11, which would silently raise the floor.
 */
export const BASE_PACKAGES: readonly string[] = [
  'matplotlib==3.10.9',
  'numpy==2.2.6',
  'pillow==12.3.0',
  'python-docx==1.2.0',
  'openpyxl==3.1.5'
]

/** Rough headroom for the venv plus the base packages (matplotlib, numpy, pillow are the bulk). */
const MIN_FREE_BYTES = 600 * 1024 * 1024

const PROBE_TIMEOUT_MS = 15_000
const VENV_TIMEOUT_MS = 120_000
const PIP_TIMEOUT_MS = 15 * 60_000

/** Written inside the venv by this app, so a later launch can tell "we created this and the packages never finished" from "the user brought their own venv". */
const MARKER_FILE = '.sachiv-runtime.json'

export interface RunResult {
  /** `null` when the process could not be started (e.g. the command does not exist) or was killed on timeout. */
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface RuntimeDeps {
  run(command: string, args: string[], opts: { timeoutMs: number }): Promise<RunResult>
  platform: NodeJS.Platform
  exists(p: string): boolean
  mkdirp(p: string): Promise<void>
  removeDir(p: string): Promise<void>
  readText(p: string): Promise<string | undefined>
  writeText(p: string, content: string): Promise<void>
  /** Free bytes on the volume holding `p`, or `undefined` when unknown (the check is then skipped). */
  freeBytes(p: string): Promise<number | undefined>
  /**
   * Absolute path to a bundled interpreter's executable, when the packaged app ships one for
   * this platform (the Windows sponsor build, TASKS #202 — `scripts/fetch-bundled-python-win.mjs`
   * + `electron-builder.yml`'s `win.extraResources`). `undefined` in dev, in CI, and on any
   * platform/build that ships none — detection then falls back to the system Python probe below.
   */
  bundledPython?(): string | undefined
  /**
   * Absolute path to a local wheel cache for the bundled interpreter's pinned packages, so
   * installing them needs no network. `undefined` when there is no bundled interpreter.
   */
  bundledWheelhouse?(): string | undefined
}

export function defaultRuntimeDeps(): RuntimeDeps {
  return {
    platform: process.platform,
    exists: existsSync,
    run: (command, args, { timeoutMs }) =>
      new Promise((resolve) => {
        execFile(
          command,
          args,
          { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null
            resolve({
              code: !e ? 0 : typeof e.code === 'number' ? e.code : null,
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? '') || (e && typeof e.code !== 'number' ? e.message : ''),
              timedOut: Boolean(e?.killed)
            })
          }
        )
      }),
    mkdirp: async (p) => {
      await mkdir(p, { recursive: true })
    },
    removeDir: (p) => rm(p, { recursive: true, force: true }),
    readText: async (p) => {
      try {
        return await readFile(p, 'utf-8')
      } catch {
        return undefined
      }
    },
    writeText: (p, content) => writeFile(p, content, 'utf-8'),
    freeBytes: async (p) => {
      try {
        const s = await statfs(p)
        return Number(s.bavail) * Number(s.bsize)
      } catch {
        return undefined
      }
    },
    bundledPython: () => {
      let p: string | undefined
      if (process.platform === 'win32') p = bundledResourcePath('python-win-x64', 'python.exe')
      else if (process.platform === 'darwin') p = bundledResourcePath('python-mac-arm64', 'bin', 'python3')
      else p = bundledResourcePath('python-linux-x64', 'bin', 'python3')
      return p && existsSync(p) ? p : undefined
    },
    bundledWheelhouse: () => {
      const dir = process.platform === 'win32' ? 'python-win-x64-wheels' : process.platform === 'darwin' ? 'python-mac-arm64-wheels' : 'python-linux-x64-wheels'
      const p = bundledResourcePath(dir)
      return p && existsSync(p) ? p : undefined
    }
  }
}

/**
 * Path under the packaged app's `resources/` (Electron sets `process.resourcesPath`;
 * unset outside Electron, e.g. under Vitest/plain Node — returns `undefined` there, which
 * is correct: no bundled interpreter exists in dev). Windows (TASKS #202), Linux (TASKS #207)
 * and macOS (TASKS #208, Apple Silicon only) — all single-architecture for now (AMD64 on
 * Windows/Linux, arm64 on mac; Intel Mac is deliberately deferred).
 */
function bundledResourcePath(...segments: string[]): string | undefined {
  if (process.platform !== 'win32' && process.platform !== 'linux' && process.platform !== 'darwin') return undefined
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return resourcesPath ? path.join(resourcesPath, ...segments) : undefined
}

// --- Detection ---------------------------------------------------------------

export interface PythonInterpreter {
  command: string
  /** Arguments that must precede the caller's own (`['-3']` for the Windows `py` launcher). */
  args: string[]
  version: string
}

export type PythonDetection = { ok: true; python: PythonInterpreter } | { ok: false; reason: string }

const PROBE_CODE = 'import sys, venv, ensurepip; print("%d.%d.%d" % sys.version_info[:3])'

const NOT_FOUND_REASON =
  `Python ${MIN_PYTHON.major}.${MIN_PYTHON.minor} or newer was not found. Install Python from python.org ` +
  '(or your package manager), then choose Retry.'

function candidates(platform: NodeJS.Platform): Array<{ command: string; args: string[] }> {
  // Windows: prefer the `py` launcher — a bare `python` may be the Microsoft Store stub.
  return platform === 'win32'
    ? [
        { command: 'py', args: ['-3'] },
        { command: 'python', args: [] },
        { command: 'python3', args: [] }
      ]
    : [
        { command: 'python3', args: [] },
        { command: 'python', args: [] }
      ]
}

function parseVersion(text: string): { major: number; minor: number; full: string } | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)\s*$/.exec(text.trim())
  return m ? { major: Number(m[1]), minor: Number(m[2]), full: `${m[1]}.${m[2]}.${m[3]}` } : undefined
}

/**
 * Finds a system Python that is new enough AND can build a venv. The probe
 * imports `venv` and `ensurepip`, because Debian/Ubuntu ship them in a
 * separate `python3-venv` package — `python3 --version` alone would wrongly
 * pass there. Every probe is time-limited (macOS's CLT shim can hang on an
 * installer dialog).
 */
export async function detectPython(deps: Pick<RuntimeDeps, 'run' | 'platform' | 'bundledPython'>): Promise<PythonDetection> {
  let best: string | undefined
  const bundled = deps.bundledPython?.()
  const list = bundled ? [{ command: bundled, args: [] }, ...candidates(deps.platform)] : candidates(deps.platform)
  for (const c of list) {
    const r = await deps.run(c.command, [...c.args, '-c', PROBE_CODE], { timeoutMs: PROBE_TIMEOUT_MS })
    if (r.timedOut) {
      best ??= `\`${c.command}\` did not respond within ${PROBE_TIMEOUT_MS / 1000}s.`
      continue
    }
    if (r.code === 0) {
      const v = parseVersion(r.stdout)
      if (!v) continue
      if (v.major < MIN_PYTHON.major || (v.major === MIN_PYTHON.major && v.minor < MIN_PYTHON.minor)) {
        best = `Found Python ${v.full}, but ${MIN_PYTHON.major}.${MIN_PYTHON.minor} or newer is required.`
        continue
      }
      return { ok: true, python: { command: c.command, args: c.args, version: v.full } }
    }
    if (/No module named '?(venv|ensurepip)/i.test(r.stderr)) {
      best = `Python was found but cannot create virtual environments (its "venv"/"ensurepip" module is missing). On Debian/Ubuntu: install the python3-venv package, then choose Retry.`
    }
    // Any other failure (command not found, Store stub, ...) → try the next candidate.
  }
  return { ok: false, reason: best ?? NOT_FOUND_REASON }
}

// --- Workspace + venv --------------------------------------------------------

/** Platform-aware so the Windows branches are testable on any OS (same approach as tools/python-env.ts). */
function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

function venvPythonPath(root: string, platform: NodeJS.Platform): string {
  return pathFor(platform).join(root, WORKSPACE_VENV_DIR, platform === 'win32' ? 'Scripts' : 'bin', platform === 'win32' ? 'python.exe' : 'python')
}

function tail(text: string, max = 400): string {
  const t = text.trim()
  return t.length > max ? '…' + t.slice(-max) : t
}

interface Marker {
  /** `false` until the base packages installed successfully. */
  packagesInstalled: boolean
}

async function readMarker(root: string, deps: RuntimeDeps): Promise<Marker | undefined> {
  const text = await deps.readText(pathFor(deps.platform).join(root, WORKSPACE_VENV_DIR, MARKER_FILE))
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text) as Partial<Marker>
    return { packagesInstalled: parsed.packagesInstalled === true }
  } catch {
    return undefined
  }
}

async function writeMarker(root: string, deps: RuntimeDeps, marker: Marker): Promise<void> {
  try {
    await deps.writeText(
      pathFor(deps.platform).join(root, WORKSPACE_VENV_DIR, MARKER_FILE),
      JSON.stringify({ ...marker, packages: BASE_PACKAGES }, null, 2)
    )
  } catch {
    // Non-fatal: without the marker the venv is simply treated as user-owned next launch.
  }
}

export interface EnsureOptions {
  /** The user chose "continue without Python": create the folders, skip the venv. */
  skipPython?: boolean
  /** Remove the existing `<root>/venv` first and rebuild it (explicit user action). */
  repair?: boolean
}

/**
 * Manages the runtime state for the current workspace and notifies listeners
 * on every change. One instance per app.
 */
export class WorkspaceRuntime {
  private state: RuntimeState | undefined
  private currentRoot: string | undefined
  private readonly inflight = new Map<string, Promise<RuntimeState>>()
  private readonly listeners = new Set<(state: RuntimeState) => void>()

  constructor(private readonly deps: RuntimeDeps = defaultRuntimeDeps()) {}

  getState(): RuntimeState | undefined {
    return this.state
  }

  onChange(listener: (state: RuntimeState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Idempotent. Concurrent calls for the same root share one run (so a startup
   * ensure and a set-root ensure cannot create the venv twice within this
   * process). Resolves with the final state; never rejects.
   */
  ensureWorkspace(root: string, opts: EnsureOptions = {}): Promise<RuntimeState> {
    const existing = this.inflight.get(root)
    if (existing) return existing
    this.currentRoot = root
    const run = this.runEnsure(root, opts).finally(() => this.inflight.delete(root))
    this.inflight.set(root, run)
    return run
  }

  private set(root: string, next: Omit<RuntimeState, 'root'>): RuntimeState {
    const state: RuntimeState = { ...next, root }
    // A newer ensure for a different root has taken over — don't let a slow older run overwrite it.
    if (this.currentRoot !== root) return state
    this.state = state
    for (const l of this.listeners) l(state)
    return state
  }

  private async runEnsure(root: string, opts: EnsureOptions): Promise<RuntimeState> {
    const { deps } = this
    try {
      await deps.mkdirp(root)
      for (const folder of WORKSPACE_FOLDERS) await deps.mkdirp(pathFor(deps.platform).join(root, folder))
    } catch (err) {
      return this.set(root, {
        status: 'failed',
        packages: 'none',
        message: `Could not create the workspace folders: ${err instanceof Error ? err.message : String(err)}`
      })
    }

    if (opts.skipPython) {
      return this.set(root, {
        status: 'disabled',
        packages: 'none',
        message: 'Python is turned off. Agents cannot run scripts; chat, database and Office tools still work.'
      })
    }

    const venvDir = pathFor(deps.platform).join(root, WORKSPACE_VENV_DIR)
    if (opts.repair && deps.exists(venvDir)) await deps.removeDir(venvDir)

    const bin = workspaceVenvBinDir(root, { platform: deps.platform, exists: deps.exists })
    if (bin) return this.adoptOrFinish(root)
    if (deps.exists(venvDir)) {
      return this.set(root, {
        status: 'failed',
        packages: 'none',
        message: `"${WORKSPACE_VENV_DIR}" already exists in the workspace but is not a usable Python environment. Move it aside, or choose Repair to rebuild it (this deletes it).`
      })
    }

    const detection = await detectPython(deps)
    if (!detection.ok) return this.set(root, { status: 'missing-python', packages: 'none', message: detection.reason })
    const { python } = detection

    const free = await deps.freeBytes(root)
    if (free !== undefined && free < MIN_FREE_BYTES) {
      return this.set(root, {
        status: 'failed',
        packages: 'none',
        pythonVersion: python.version,
        message: `Not enough free disk space for the Python environment (${Math.round(free / 1024 / 1024)} MB free, about ${MIN_FREE_BYTES / 1024 / 1024} MB needed).`
      })
    }

    this.set(root, {
      status: 'creating',
      packages: 'none',
      pythonVersion: python.version,
      message: 'Creating the Python environment…'
    })
    const created = await deps.run(python.command, [...python.args, '-m', 'venv', venvDir], { timeoutMs: VENV_TIMEOUT_MS })
    if (created.code !== 0 || !workspaceVenvBinDir(root, { platform: deps.platform, exists: deps.exists })) {
      // We just made this partial venv — safe to remove, so Retry starts clean.
      await deps.removeDir(venvDir)
      return this.set(root, {
        status: 'failed',
        packages: 'none',
        pythonVersion: python.version,
        message: `Creating the Python environment failed: ${tail(created.timedOut ? 'timed out' : created.stderr || created.stdout) || 'unknown error'}`
      })
    }
    await writeMarker(root, deps, { packagesInstalled: false })
    return this.installPackages(root, python.version)
  }

  /** An existing venv: adopt it if its interpreter runs, and finish any base-package install this app started earlier. */
  private async adoptOrFinish(root: string): Promise<RuntimeState> {
    const { deps } = this
    const probe = await deps.run(venvPythonPath(root, deps.platform), ['-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], {
      timeoutMs: PROBE_TIMEOUT_MS
    })
    const version = probe.code === 0 ? parseVersion(probe.stdout)?.full : undefined
    if (!version) {
      return this.set(root, {
        status: 'failed',
        packages: 'none',
        message: `The workspace's Python environment cannot start (${tail(probe.stderr) || 'no output'}). It may have been moved, or the Python it was built from was removed. Choose Repair to rebuild it.`
      })
    }
    const marker = await readMarker(root, deps)
    if (!marker) {
      return this.set(root, { status: 'ready', packages: 'adopted', pythonVersion: version, message: 'Using the existing Python environment in the workspace.' })
    }
    if (marker.packagesInstalled) {
      return this.set(root, { status: 'ready', packages: 'installed', pythonVersion: version, message: 'Python environment ready.' })
    }
    return this.installPackages(root, version)
  }

  private async installPackages(root: string, pythonVersion: string): Promise<RuntimeState> {
    const { deps } = this
    const wheelhouse = deps.bundledWheelhouse?.()
    this.set(root, {
      status: 'ready',
      packages: 'installing',
      pythonVersion,
      message: 'Installing base packages (matplotlib, numpy, pillow, python-docx, openpyxl) — this can take a few minutes.'
    })
    const r = await deps.run(
      venvPythonPath(root, deps.platform),
      [
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        '--no-input',
        // The bundled Windows interpreter ships its own pinned wheels (TASKS #202), so installing
        // from them needs no network and can't drift onto a newer, untested package version.
        ...(wheelhouse ? ['--no-index', '--find-links', wheelhouse] : []),
        ...BASE_PACKAGES
      ],
      { timeoutMs: PIP_TIMEOUT_MS }
    )
    if (r.code === 0) {
      await writeMarker(root, deps, { packagesInstalled: true })
      return this.set(root, { status: 'ready', packages: 'installed', pythonVersion, message: 'Python environment ready.' })
    }
    return this.set(root, {
      status: 'ready',
      packages: 'failed',
      pythonVersion,
      message: wheelhouse
        ? `The Python environment was created, but installing the bundled base packages failed (${tail(r.timedOut ? 'timed out' : r.stderr) || 'unknown error'}). Choose Retry.`
        : `The Python environment was created, but installing the base packages failed (${tail(r.timedOut ? 'timed out' : r.stderr) || 'unknown error'}). Check your network connection and choose Retry.`
    })
  }
}
