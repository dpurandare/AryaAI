import { describe, expect, it, vi } from 'vitest'
import type { OllamaRuntimeState } from '@shared/runtime'
import type { OllamaRuntimeDeps } from './ollama-runtime'

// ollama-runtime.ts imports `electron` directly (app.getPath, for the real modelsDir()) —
// same hazard documented in mcp/config.test.ts / tools/setup.test.ts: the real package isn't
// resolvable outside an actual Electron process, so every test file importing this module
// needs this mock even though none of these tests call modelsDir() itself.
vi.mock('electron', () => ({
  app: { getPath: () => '/fake/userData' }
}))

const { OllamaRuntime, defaultOllamaRuntimeDeps } = await import('./ollama-runtime')

const EXE = 'C:\\Program Files\\Sachivji\\resources\\ollama-win-x64\\ollama.exe'
const MODELFILE = 'C:\\Program Files\\Sachivji\\resources\\ModelFileNomicEmbed'
const MODELS_DIR = 'C:\\Users\\sponsor\\AppData\\Roaming\\Sachivji\\ollama-models'

interface Harness {
  deps: OllamaRuntimeDeps
  killed: boolean
  spawnCalls: Array<{ exe: string; port: number; modelsDir: string }>
  applyCalls: Array<{ exe: string; baseUrl: string; modelfilePath: string }>
}

function harness(
  opts: {
    bundledExe?: string | undefined
    modelfilePath?: string | undefined
    portsFree?: Set<number>
    healthy?: boolean
    pullError?: string
    pullProgress?: Array<{ completed: number; total: number }>
    applyError?: string
  } = {}
): Harness {
  const bundledExe = 'bundledExe' in opts ? opts.bundledExe : EXE
  const modelfilePath = 'modelfilePath' in opts ? opts.modelfilePath : MODELFILE
  const portsFree = opts.portsFree ?? new Set([11434])
  const spawnCalls: Harness['spawnCalls'] = []
  const applyCalls: Harness['applyCalls'] = []
  let killed = false
  const deps: OllamaRuntimeDeps = {
    bundledExe: () => bundledExe,
    modelfilePath: () => modelfilePath,
    modelsDir: () => MODELS_DIR,
    isPortFree: async (port) => portsFree.has(port),
    spawnServer: (exe, port, modelsDir) => {
      spawnCalls.push({ exe, port, modelsDir })
      return { kill: () => (killed = true) }
    },
    waitUntilHealthy: async () => opts.healthy ?? true,
    pullModel: async (_baseUrl, _model, onProgress) => {
      if (opts.pullError) throw new Error(opts.pullError)
      for (const p of opts.pullProgress ?? []) onProgress(p)
    },
    applyModelfile: async (exe, baseUrl, path) => {
      applyCalls.push({ exe, baseUrl, modelfilePath: path })
      if (opts.applyError) throw new Error(opts.applyError)
    }
  }
  const h = { spawnCalls, applyCalls } as Harness
  Object.defineProperty(h, 'killed', { get: () => killed })
  h.deps = deps
  return h
}

describe('OllamaRuntime', () => {
  it('is unavailable when no bundled exe is reported (dev, mac, linux, or a build without the resource)', async () => {
    const h = harness({ bundledExe: undefined })
    const state = await new OllamaRuntime(h.deps).ensure()
    expect(state.status).toBe('unavailable')
    expect(h.spawnCalls).toHaveLength(0)
  })

  it('happy path: starting -> pulling-model (with progress) -> ready, applying the context-size fix', async () => {
    const h = harness({ pullProgress: [{ completed: 50, total: 100 }, { completed: 100, total: 100 }] })
    const seen: OllamaRuntimeState[] = []
    const rt = new OllamaRuntime(h.deps)
    rt.onChange((s) => seen.push(s))

    const final = await rt.ensure()

    expect(seen.map((s) => s.status)).toEqual(['starting', 'pulling-model', 'pulling-model', 'pulling-model', 'ready'])
    expect(seen[2].modelPullProgress).toEqual({ completed: 50, total: 100 })
    expect(seen[3].modelPullProgress).toEqual({ completed: 100, total: 100 })
    expect(final.status).toBe('ready')
    expect(final.baseUrl).toBe('http://127.0.0.1:11434')
    expect(h.spawnCalls).toEqual([{ exe: EXE, port: 11434, modelsDir: MODELS_DIR }])
    expect(h.applyCalls).toEqual([{ exe: EXE, baseUrl: 'http://127.0.0.1:11434', modelfilePath: MODELFILE }])
  })

  it('falls back to the next free port when the default is already in use (e.g. the sponsor runs their own Ollama)', async () => {
    const h = harness({ portsFree: new Set([11436]) })
    const final = await new OllamaRuntime(h.deps).ensure()
    expect(final.baseUrl).toBe('http://127.0.0.1:11436')
    expect(h.spawnCalls[0].port).toBe(11436)
  })

  it('fails cleanly, killing the server, when none of the tried ports are free', async () => {
    const h = harness({ portsFree: new Set() })
    const final = await new OllamaRuntime(h.deps).ensure()
    expect(final.status).toBe('failed')
    expect(h.spawnCalls).toHaveLength(0)
  })

  it('fails and kills the server when the health check never passes', async () => {
    const h = harness({ healthy: false })
    const final = await new OllamaRuntime(h.deps).ensure()
    expect(final.status).toBe('failed')
    expect(final.message).toMatch(/did not become ready/)
    expect(h.killed).toBe(true)
  })

  it('fails with the base URL set when the model pull itself fails', async () => {
    const h = harness({ pullError: 'disk full' })
    const final = await new OllamaRuntime(h.deps).ensure()
    expect(final.status).toBe('failed')
    expect(final.message).toContain('disk full')
    expect(final.baseUrl).toBe('http://127.0.0.1:11434')
  })

  it('skips applyModelfile and goes straight to ready when no modelfile is bundled', async () => {
    const h = harness({ modelfilePath: undefined })
    const final = await new OllamaRuntime(h.deps).ensure()
    expect(final.status).toBe('ready')
    expect(h.applyCalls).toHaveLength(0)
  })

  it('fails when applying the context-size fix fails, after a successful pull', async () => {
    const h = harness({ applyError: 'ollama create failed' })
    const final = await new OllamaRuntime(h.deps).ensure()
    expect(final.status).toBe('failed')
    expect(final.message).toContain('ollama create failed')
  })

  it('ensure() is idempotent — concurrent calls share one run, spawning only once', async () => {
    const h = harness()
    const rt = new OllamaRuntime(h.deps)
    const [a, b] = await Promise.all([rt.ensure(), rt.ensure()])
    expect(a).toBe(b)
    expect(h.spawnCalls).toHaveLength(1)
  })

  it('stop() kills the running server', async () => {
    const h = harness()
    const rt = new OllamaRuntime(h.deps)
    await rt.ensure()
    rt.stop()
    expect(h.killed).toBe(true)
  })

  it('getState() reflects the latest state after ensure() resolves', async () => {
    const h = harness()
    const rt = new OllamaRuntime(h.deps)
    expect(rt.getState()).toBeUndefined()
    await rt.ensure()
    expect(rt.getState()?.status).toBe('ready')
  })
})

describe('defaultOllamaRuntimeDeps', () => {
  it('bundledExe/modelfilePath return undefined under Vitest even on a supported platform (no real resourcesPath outside Electron)', () => {
    const deps = defaultOllamaRuntimeDeps()
    expect(deps.bundledExe()).toBeUndefined()
    expect(deps.modelfilePath()).toBeUndefined()
  })
})
