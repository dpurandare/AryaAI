#!/usr/bin/env node
/**
 * Fetches a self-contained Ollama for the macOS Apple Silicon release (TASKS #208, extending
 * the Windows (#202) and Linux (#207) bundled-runtime approach), so local embeddings work with
 * no manual Ollama install. The embedding model itself is NOT fetched here — it's pulled over
 * the network on first run instead (see OllamaRuntime / the app's onboarding step).
 *
 * UNLIKE Windows/Linux, this is deliberately conservative rather than stripped to a minimal CPU
 * subset — see TASKS #208 for the full reasoning, summarized here: the official macOS tarball
 * (`ollama-darwin.tgz`) is already architecture-general (the main `ollama` binary and most
 * `.dylib`s are universal x86_64+arm64 Mach-O files), but on Apple Silicon the actual compute
 * backend appears to run through the `mlx_metal_v3`/`mlx_metal_v4` folders (Metal GPU shaders,
 * ~400MB combined) rather than the small per-microarchitecture `libggml-cpu-*.so` files (which
 * ARE unambiguously x86-only by name — alderlake, cascadelake, zen4, etc — and are the only
 * thing excluded here). This machine cannot execute arm64 Mach-O binaries at all (it's x64
 * Linux), so unlike the Windows/Linux scripts, nothing here could be verified by actually
 * running the result — excluding the wrong file would silently break Ollama on a real Mac with
 * no way to catch it from here. **TASKS #208 carries an explicit, prioritized follow-up to
 * verify this choice (and look for further safe size reductions) on real Apple Silicon
 * hardware.** Until then, bundle size here (~480MB) is deliberately larger than Windows (~66MB)
 * or Linux (~103MB).
 *
 * Only touches files under resources/ollama-mac-arm64 (gitignored — a fetched asset, not
 * source). Safe to re-run: skips work already done unless --force.
 *
 * Usage: node scripts/fetch-bundled-ollama-mac.mjs [--force]
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { download, sha256OfFile } from './fetch-utils.mjs'

const execFileAsync = promisify(execFile)

// Pinned release (ollama/ollama) — same tag as the Windows/Linux scripts; update deliberately,
// not casually: re-verify the sha256 from that release's own sha256sum.txt asset when you do.
const OLLAMA_TAG = 'v0.40.3'
const OLLAMA_ASSET = 'ollama-darwin.tgz'
const OLLAMA_URL = `https://github.com/ollama/ollama/releases/download/${OLLAMA_TAG}/${OLLAMA_ASSET}`
const OLLAMA_SHA256 = 'a2d1d906a2c8febd9cb18f5c183854d0a6db5dc522940d68b0c0ed048e8dfdea'

// Unambiguously x86-only per-microarchitecture CPU backends (Apple Silicon never loads these —
// confirmed by name, every one is an Intel/AMD codename). Everything else, including the large
// mlx_metal_v3/v4 Metal shader bundles, is kept — see the file comment above for why.
const EXCLUDED_GLOBS = ['libggml-cpu-*.so']

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OLLAMA_DIR = path.join(ROOT, 'resources', 'ollama-mac-arm64')

const force = process.argv.includes('--force')

function log(msg) {
  console.log(`[fetch-bundled-ollama-mac] ${msg}`)
}

async function fetchOllama() {
  if (!force && existsSync(path.join(OLLAMA_DIR, 'ollama'))) {
    log('already present, skipping (use --force to redo)')
    return
  }
  await rm(OLLAMA_DIR, { recursive: true, force: true })
  // tar extracts straight into OLLAMA_DIR (no intermediate rename), so unlike the Python fetch
  // script there's no cross-device-rename hazard — the OS tmpdir is fine for the download.
  const tmp = mkdtempSync(path.join(tmpdir(), 'ollama-dl-'))
  const archive = path.join(tmp, OLLAMA_ASSET)
  try {
    log(`downloading ${OLLAMA_ASSET} (~167MB compressed)…`)
    await download(OLLAMA_URL, archive)
    const actual = await sha256OfFile(archive)
    if (actual !== OLLAMA_SHA256) {
      throw new Error(`checksum mismatch for ${OLLAMA_ASSET}: expected ${OLLAMA_SHA256}, got ${actual}`)
    }
    log('checksum OK, extracting (keeping the Metal/MLX backends — see this script\'s header comment)…')
    await mkdir(OLLAMA_DIR, { recursive: true })
    await execFileAsync('tar', ['-xzf', archive, ...EXCLUDED_GLOBS.flatMap((g) => [`--exclude=${g}`]), '-C', OLLAMA_DIR])
    log(`ollama ready at ${path.relative(ROOT, OLLAMA_DIR)} (only x86 CPU-microarchitecture libs stripped)`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

fetchOllama().catch((err) => {
  console.error(`[fetch-bundled-ollama-mac] FAILED: ${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
