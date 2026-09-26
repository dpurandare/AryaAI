import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '@shared/runtime'
import {
  BASE_PACKAGES,
  detectPython,
  WorkspaceRuntime,
  type RunResult,
  type RuntimeDeps
} from './workspace-runtime'

const ROOT = '/ws/Sachivji Workspace'
const VENV = `${ROOT}/venv`
const VENV_PY = `${VENV}/bin/python`

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false })
const fail = (stderr: string, code: number | null = 1): RunResult => ({ code, stdout: '', stderr, timedOut: false })

interface Harness {
  deps: RuntimeDeps
  files: Map<string, string>
  dirs: Set<string>
  calls: Array<{ command: string; args: string[] }>
  removed: string[]
}

/**
 * In-memory filesystem + scripted process runner. `handler` answers each
 * `run`; a successful `-m venv` call creates the fake venv interpreter the
 * same way the real command would.
 */
function harness(
  handler: (command: string, args: string[], h: Harness) => RunResult | undefined,
  opts: { platform?: NodeJS.Platform; free?: number | undefined; existing?: string[] } = {}
): Harness {
  const files = new Map<string, string>()
  const dirs = new Set<string>(opts.existing ?? [])
  const calls: Harness['calls'] = []
  const removed: string[] = []
  const h: Harness = { files, dirs, calls, removed } as Harness
  h.deps = {
    platform: opts.platform ?? 'linux',
    exists: (p) => dirs.has(p) || files.has(p),
    mkdirp: async (p) => {
      dirs.add(p)
    },
    removeDir: async (p) => {
      removed.push(p)
      for (const k of [...dirs, ...files.keys()]) if (k === p || k.startsWith(p + '/')) {
        dirs.delete(k)
        files.delete(k)
      }
    },
    readText: async (p) => files.get(p),
    writeText: async (p, c) => {
      files.set(p, c)
    },
    freeBytes: async () => ('free' in opts ? opts.free : 10 * 1024 * 1024 * 1024),
    run: async (command, args) => {
      calls.push({ command, args })
      const custom = handler(command, args, h)
      if (custom) return custom
      if (args.includes('venv') && args.includes('-m')) {
        const target = args[args.length - 1]
        const win = opts.platform === 'win32'
        dirs.add(target)
        files.set(win ? path.win32.join(target, 'Scripts', 'python.exe') : `${target}/bin/python`, '')
        return ok()
      }
      return fail(`unexpected: ${command} ${args.join(' ')}`)
    }
  }
  return h
}

describe('detectPython', () => {
  it('accepts a new-enough interpreter that can build venvs', async () => {
    const h = harness((_c, a) => (a.includes('-c') ? ok('3.12.3\n') : undefined))
    const r = await detectPython(h.deps)
    expect(r).toEqual({ ok: true, python: { command: 'python3', args: [], version: '3.12.3' } })
    // The probe must import venv AND ensurepip — `--version` alone passes on Debian without python3-venv.
    expect(h.calls[0].args.join(' ')).toMatch(/import sys, venv, ensurepip/)
  })

  it('rejects a Python older than the minimum and says which version it found', async () => {
    const h = harness(() => ok('3.9.6\n'))
    const r = await detectPython(h.deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/3\.9\.6.*3\.10 or newer/)
  })

  it('reports a missing venv/ensurepip module with the Debian remedy', async () => {
    const h = harness(() => fail("ModuleNotFoundError: No module named 'ensurepip'"))
    const r = await detectPython(h.deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/python3-venv/)
  })

  it('reports plain "not found" when no candidate runs', async () => {
    const h = harness(() => ({ code: null, stdout: '', stderr: 'spawn python3 ENOENT', timedOut: false }))
    const r = await detectPython(h.deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/was not found/)
  })

  it('falls through to the next candidate', async () => {
    const h = harness((c) => (c === 'python3' ? { code: null, stdout: '', stderr: 'ENOENT', timedOut: false } : ok('3.11.4\n')))
    const r = await detectPython(h.deps)
    expect(r).toMatchObject({ ok: true, python: { command: 'python', version: '3.11.4' } })
  })

  it('prefers the py launcher on Windows (a bare `python` may be the Store stub)', async () => {
    const h = harness(() => ok('3.12.1\n'), { platform: 'win32' })
    const r = await detectPython(h.deps)
    expect(r).toMatchObject({ ok: true, python: { command: 'py', args: ['-3'] } })
    expect(h.calls[0]).toMatchObject({ command: 'py', args: ['-3', '-c', expect.any(String)] })
  })

  it('reports a probe that hangs', async () => {
    const h = harness(() => ({ code: null, stdout: '', stderr: '', timedOut: true }))
    const r = await detectPython(h.deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/did not respond/)
  })
})

describe('WorkspaceRuntime.ensureWorkspace', () => {
  it('creates the managed folders, the venv, and installs the pinned base packages', async () => {
    const h = harness((_c, a) => {
      if (a.includes('-c')) return ok('3.12.3\n')
      if (a.includes('pip')) return ok()
      return undefined
    })
    const rt = new WorkspaceRuntime(h.deps)
    const states: RuntimeState[] = []
    rt.onChange((s) => states.push(s))

    const final = await rt.ensureWorkspace(ROOT)

    expect(final).toMatchObject({ status: 'ready', packages: 'installed', pythonVersion: '3.12.3', root: ROOT })
    for (const f of ['code', 'documents', 'resources']) expect(h.dirs.has(`${ROOT}/${f}`)).toBe(true)
    const pip = h.calls.find((c) => c.args.includes('pip'))
    expect(pip?.command).toBe(VENV_PY) // always the venv's python -m pip, never a bare pip
    expect(pip?.args).toEqual(expect.arrayContaining([...BASE_PACKAGES]))
    // Every base package is pinned to an exact version.
    for (const p of BASE_PACKAGES) expect(p).toMatch(/==\d/)
    expect(states.map((s) => `${s.status}/${s.packages}`)).toEqual([
      'creating/none',
      'ready/installing',
      'ready/installed'
    ])
    expect(JSON.parse(h.files.get(`${VENV}/.sachiv-runtime.json`)!).packagesInstalled).toBe(true)
  })

  it('reports missing-python without touching the venv, but still creates the folders', async () => {
    const h = harness(() => ({ code: null, stdout: '', stderr: 'ENOENT', timedOut: false }))
    const final = await new WorkspaceRuntime(h.deps).ensureWorkspace(ROOT)
    expect(final.status).toBe('missing-python')
    expect(h.dirs.has(`${ROOT}/documents`)).toBe(true)
    expect(h.dirs.has(VENV)).toBe(false)
  })

  it('adopts an existing venv without recreating it or installing anything', async () => {
    const h = harness((_c, a) => (a.includes('-c') ? ok('3.12.3\n') : undefined), { existing: [VENV] })
    h.files.set(VENV_PY, '')
    const final = await new WorkspaceRuntime(h.deps).ensureWorkspace(ROOT)
    expect(final).toMatchObject({ status: 'ready', packages: 'adopted', pythonVersion: '3.12.3' })
    expect(h.calls.every((c) => !c.args.includes('venv') && !c.args.includes('pip'))).toBe(true)
    expect(h.removed).toEqual([])
  })

  it('reports a broken existing venv and does NOT delete it', async () => {
    const h = harness(() => fail('bad interpreter: No such file or directory', 126), { existing: [VENV] })
    h.files.set(VENV_PY, '')
    const final = await new WorkspaceRuntime(h.deps).ensureWorkspace(ROOT)
    expect(final.status).toBe('failed')
    expect(final.message).toMatch(/Repair/)
    expect(h.removed).toEqual([])
    expect(h.dirs.has(VENV)).toBe(true)
  })

  it('refuses to build into a `venv` folder that is not a Python environment', async () => {
    const h = harness(() => ok('3.12.3\n'), { existing: [VENV] })
    const final = await new WorkspaceRuntime(h.deps).ensureWorkspace(ROOT)
    expect(final.status).toBe('failed')
    expect(h.calls.some((c) => c.args.includes('venv'))).toBe(false)
    expect(h.removed).toEqual([])
  })

  it('repair removes the existing venv, then rebuilds it', async () => {
    const h = harness((_c, a) => (a.includes('-c') ? ok('3.12.3\n') : a.includes('pip') ? ok() : undefined), { existing: [VENV] })
    h.files.set(VENV_PY, '')
    const final = await new WorkspaceRuntime(h.deps).ensureWorkspace(ROOT, { repair: true })
    expect(h.removed).toEqual([VENV])
    expect(final).toMatchObject({ status: 'ready', packages: 'installed' })
  })

  it('removes the partial venv it just made when creation fails, so Retry starts clean', async () => {
    const h = harness((_c, a) => {
      if (a.includes('-c')) return ok('3.12.3\n')
      if (a.includes('venv') && a.includes('-m')) {
        h.dirs.add(VENV) // partial leftovers
        return fail('Error: Command returned non-zero exit status 1')
      }
      return undefined
    })
    const final = await new WorkspaceRuntime(h.deps).ensureWorkspace(ROOT)
    expect(final.status).toBe('failed')
    expect(final.message).toMatch(/Creating the Python environment failed/)
    expect(h.removed).toEqual([VENV])
    expect(h.dirs.has(VENV)).toBe(false)
  })

  it('a package-install failure leaves a usable venv, and the next ensure retries just the install', async () => {
    let pipOk = false
    const h = harness((_c, a) => {
      if (a.includes('-c')) return ok('3.12.3\n')
      if (a.includes('pip')) return pipOk ? ok() : fail('Could not connect to PyPI')
      return undefined
    })
    const rt = new WorkspaceRuntime(h.deps)
    const first = await rt.ensureWorkspace(ROOT)
    expect(first).toMatchObject({ status: 'ready', packages: 'failed' })
    expect(first.message).toMatch(/Retry/)

    pipOk = true
    const venvCallsBefore = h.calls.filter((c) => c.args.includes('venv')).length
    const second = await rt.ensureWorkspace(ROOT)
    expect(second).toMatchObject({ status: 'ready', packages: 'installed' })
    expect(h.calls.filter((c) => c.args.includes('venv')).length).toBe(venvCallsBefore) // venv not recreated
  })

  it('skipPython creates the folders and reports disabled', async () => {
    const h = harness(() => undefined)
    const final = await new WorkspaceRuntime(h.deps).ensureWorkspace(ROOT, { skipPython: true })
    expect(final.status).toBe('disabled')
    expect(h.dirs.has(`${ROOT}/code`)).toBe(true)
    expect(h.calls).toEqual([])
  })

  it('fails early, with a clear message, when the disk is nearly full', async () => {
    const h = harness((_c, a) => (a.includes('-c') ? ok('3.12.3\n') : undefined), { free: 50 * 1024 * 1024 })
    const final = await new WorkspaceRuntime(h.deps).ensureWorkspace(ROOT)
    expect(final.status).toBe('failed')
    expect(final.message).toMatch(/disk space/)
    expect(h.calls.some((c) => c.args.includes('venv') && c.args.includes('-m'))).toBe(false)
  })

  it('skips the disk check when free space is unknown', async () => {
    const h = harness((_c, a) => (a.includes('-c') ? ok('3.12.3\n') : a.includes('pip') ? ok() : undefined), { free: undefined })
    expect((await new WorkspaceRuntime(h.deps).ensureWorkspace(ROOT)).status).toBe('ready')
  })

  it('concurrent calls for the same root share one run (no double venv creation)', async () => {
    const h = harness((_c, a) => (a.includes('-c') ? ok('3.12.3\n') : a.includes('pip') ? ok() : undefined))
    const rt = new WorkspaceRuntime(h.deps)
    const [a, b] = await Promise.all([rt.ensureWorkspace(ROOT), rt.ensureWorkspace(ROOT)])
    expect(a).toBe(b)
    expect(h.calls.filter((c) => c.args.includes('venv') && c.args.includes('-m')).length).toBe(1)
  })

  it('a slow run for an old root cannot overwrite the state of a newer root', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = harness((_c, a) => (a.includes('-c') ? ok('3.12.3\n') : a.includes('pip') ? ok() : undefined))
    const inner = h.deps.run
    h.deps.run = async (command, args, o) => {
      if (args.includes('pip') && command.startsWith('/ws/A/')) await gate // root A's install is slow
      return inner(command, args, o)
    }
    const rt = new WorkspaceRuntime(h.deps)
    const first = rt.ensureWorkspace('/ws/A')
    await new Promise((r) => setTimeout(r, 0))
    const second = await rt.ensureWorkspace('/ws/B')
    release()
    await first
    expect(second.root).toBe('/ws/B')
    expect(rt.getState()?.root).toBe('/ws/B')
  })

  it('works with Windows paths and the Scripts folder', async () => {
    const win = 'C:\\ws'
    const h = harness((_c, a) => (a.includes('-c') ? ok('3.12.3\n') : a.includes('pip') ? ok() : undefined), { platform: 'win32' })
    const final = await new WorkspaceRuntime(h.deps).ensureWorkspace(win)
    expect(final.status).toBe('ready')
    const pip = h.calls.find((c) => c.args.includes('pip'))
    expect(pip?.command).toBe(path.win32.join(win, 'venv', 'Scripts', 'python.exe'))
    expect(h.dirs.has(path.win32.join(win, 'documents'))).toBe(true)
  })
})
