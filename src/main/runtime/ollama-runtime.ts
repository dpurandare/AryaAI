import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { OllamaRuntimeState } from '@shared/runtime'

/**
 * The bundled, CPU-only Ollama runtime shipped with the Windows sponsor build (TASKS #202):
 * starts `ollama.exe serve` from the packaged resources, waits for it to answer, then pulls the
 * `nomic-embed-text` embedding model over the network (not bundled — it's fetched here instead,
 * so the installer itself stays small) and re-creates it in place with the context-size fix
 * `models/ModelFileNomicEmbed` documents (the model's published default, 8192, exceeds its real
 * trained context of 2048 and crashes `llama-server` on an embed call otherwise).
 *
 * A strict no-op everywhere else: `bundledExe()` returns `undefined` on every build that isn't
 * one of these bundles (dev, mac, or a win32/linux build without the resource), so a user's own
 * "bring your own Ollama" setup is never started, stopped, or otherwise touched by this module.
 * Linux bundling (TASKS #207) extends the same approach from the Windows sponsor build (#202).
 */

const execFileAsync = promisify(execFile)

const EMBEDDING_MODEL = 'nomic-embed-text'
const HEALTH_TIMEOUT_MS = 20_000
const HEALTH_POLL_MS = 300
const DEFAULT_PORT = 11434
/** Tried in order if the default is already bound — e.g. the sponsor already runs their own Ollama for something else. */
const PORT_FALLBACKS = [11435, 11436, 11437, 11438]

export interface OllamaServerHandle {
  kill(): void
}

export interface OllamaRuntimeDeps {
  /** Absolute path to the bundled `ollama.exe`, or `undefined` when this build doesn't ship one. */
  bundledExe(): string | undefined
  /** Absolute path to the bundled `models/ModelFileNomicEmbed` copy, or `undefined` when unavailable (same gate as `bundledExe`). */
  modelfilePath(): string | undefined
  /** Writable directory `OLLAMA_MODELS` should point at — outside the (read-only, per-machine) install dir. */
  modelsDir(): string
  isPortFree(port: number): Promise<boolean>
  spawnServer(exe: string, port: number, modelsDir: string): OllamaServerHandle
  waitUntilHealthy(baseUrl: string, timeoutMs: number): Promise<boolean>
  pullModel(baseUrl: string, model: string, onProgress: (progress: { completed: number; total: number }) => void): Promise<void>
  /** Runs `ollama create <model> -f <modelfilePath>` against the running server. */
  applyModelfile(exe: string, baseUrl: string, modelfilePath: string): Promise<void>
}

function bundledResourcePath(...segments: string[]): string | undefined {
  if (process.platform !== 'win32' && process.platform !== 'linux') return undefined
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return resourcesPath ? path.join(resourcesPath, ...segments) : undefined
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function defaultOllamaRuntimeDeps(): OllamaRuntimeDeps {
  return {
    bundledExe: () => {
      const p =
        process.platform === 'win32' ? bundledResourcePath('ollama-win-x64', 'ollama.exe') : bundledResourcePath('ollama-linux-x64', 'bin', 'ollama')
      return p && existsSync(p) ? p : undefined
    },
    modelfilePath: () => {
      const p = bundledResourcePath('ModelFileNomicEmbed')
      return p && existsSync(p) ? p : undefined
    },
    modelsDir: () => path.join(app.getPath('userData'), 'ollama-models'),
    isPortFree,
    spawnServer: (exe, port, modelsDir) => {
      const child = spawn(exe, ['serve'], {
        env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: modelsDir },
        windowsHide: true,
        stdio: 'ignore'
      })
      return { kill: () => child.kill() }
    },
    waitUntilHealthy: async (baseUrl, timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${baseUrl}/api/version`)
          if (res.ok) return true
        } catch {
          // not up yet — keep polling
        }
        await sleep(HEALTH_POLL_MS)
      }
      return false
    },
    pullModel: async (baseUrl, model, onProgress) => {
      const res = await fetch(`${baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: model, stream: true })
      })
      if (!res.ok || !res.body) throw new Error(`pull request failed: HTTP ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line) continue
          const evt = JSON.parse(line) as { error?: string; completed?: number; total?: number }
          if (evt.error) throw new Error(evt.error)
          if (evt.completed !== undefined && evt.total !== undefined) onProgress({ completed: evt.completed, total: evt.total })
        }
      }
    },
    applyModelfile: async (exe, baseUrl, modelfilePath) => {
      const url = new URL(baseUrl)
      await execFileAsync(exe, ['create', EMBEDDING_MODEL, '-f', modelfilePath], {
        env: { ...process.env, OLLAMA_HOST: `${url.hostname}:${url.port}` },
        timeout: 60_000
      })
    }
  }
}

async function pickPort(deps: Pick<OllamaRuntimeDeps, 'isPortFree'>): Promise<number> {
  for (const port of [DEFAULT_PORT, ...PORT_FALLBACKS]) {
    if (await deps.isPortFree(port)) return port
  }
  throw new Error(`No free port found for the bundled Ollama server (tried ${DEFAULT_PORT}, ${PORT_FALLBACKS.join(', ')}).`)
}

export class OllamaRuntime {
  private state: OllamaRuntimeState | undefined
  private readonly listeners = new Set<(state: OllamaRuntimeState) => void>()
  private serverHandle: OllamaServerHandle | undefined
  private inflight: Promise<OllamaRuntimeState> | undefined

  constructor(private readonly deps: OllamaRuntimeDeps = defaultOllamaRuntimeDeps()) {}

  getState(): OllamaRuntimeState | undefined {
    return this.state
  }

  onChange(listener: (state: OllamaRuntimeState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Kills the bundled server, if one was started. Call on app quit. */
  stop(): void {
    this.serverHandle?.kill()
    this.serverHandle = undefined
  }

  /** Idempotent — concurrent calls share one run. Never rejects. */
  ensure(): Promise<OllamaRuntimeState> {
    if (this.inflight) return this.inflight
    const run = this.runEnsure().finally(() => {
      this.inflight = undefined
    })
    this.inflight = run
    return run
  }

  private set(next: OllamaRuntimeState): OllamaRuntimeState {
    this.state = next
    for (const l of this.listeners) l(next)
    return next
  }

  private async runEnsure(): Promise<OllamaRuntimeState> {
    const { deps } = this
    const exe = deps.bundledExe()
    if (!exe) {
      return this.set({ status: 'unavailable', message: 'Bundled Ollama is only included in the Windows sponsor build.' })
    }

    this.set({ status: 'starting', message: 'Starting the bundled Ollama runtime…' })

    let port: number
    try {
      port = await pickPort(deps)
    } catch (err) {
      return this.set({ status: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
    const baseUrl = `http://127.0.0.1:${port}`

    this.serverHandle = deps.spawnServer(exe, port, deps.modelsDir())
    const healthy = await deps.waitUntilHealthy(baseUrl, HEALTH_TIMEOUT_MS)
    if (!healthy) {
      this.stop()
      return this.set({ status: 'failed', message: 'The bundled Ollama server did not become ready in time.' })
    }

    this.set({ status: 'pulling-model', message: `Downloading the ${EMBEDDING_MODEL} embedding model…`, baseUrl })
    try {
      await deps.pullModel(baseUrl, EMBEDDING_MODEL, (progress) =>
        this.set({
          status: 'pulling-model',
          message: `Downloading the ${EMBEDDING_MODEL} embedding model…`,
          baseUrl,
          modelPullProgress: progress
        })
      )
    } catch (err) {
      return this.set({
        status: 'failed',
        message: `Could not download the embedding model: ${err instanceof Error ? err.message : String(err)}`,
        baseUrl
      })
    }

    const modelfilePath = deps.modelfilePath()
    if (modelfilePath) {
      try {
        await deps.applyModelfile(exe, baseUrl, modelfilePath)
      } catch (err) {
        return this.set({
          status: 'failed',
          message: `Downloaded the model but could not apply its context-size fix: ${err instanceof Error ? err.message : String(err)}`,
          baseUrl
        })
      }
    }

    return this.set({ status: 'ready', message: `Ready — ${EMBEDDING_MODEL} embedding model loaded.`, baseUrl })
  }
}
