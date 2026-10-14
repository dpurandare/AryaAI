#!/usr/bin/env node
/**
 * Fetches a self-contained, CPU-only Ollama for the Linux release (TASKS #207, extending the
 * Windows sponsor-build approach from #202), so local embeddings work with no manual Ollama
 * install. The embedding model itself is NOT fetched here — it's pulled over the network on
 * first run instead (see OllamaRuntime / the app's onboarding step), so this script only ships
 * the CPU runtime, not a multi-hundred-MB model blob.
 *
 * Ollama's official Linux release (`ollama-linux-amd64.tar.zst`) bundles CUDA v12/v13 alongside
 * the CPU backends — about 2GB of a 2.1GB uncompressed archive, almost all of it GPU libraries
 * this app never uses (no local chat model is bundled; the embedding model this app needs runs
 * fine on CPU). ROCm is a separate release asset entirely on Linux (`ollama-linux-amd64-rocm.tar.zst`)
 * and was never part of this download. This script downloads the official tar.zst, verifies it
 * whole against the release's own sha256sum.txt, then extracts only the CPU-relevant subset
 * (bin/ollama plus lib/ollama/* minus cuda_v12/cuda_v13) — about 103MB (bigger than the Windows
 * bundle's 66MB because the Linux build ships one CPU shared library per microarchitecture —
 * haswell, skylakex, zen4, etc — selected automatically at runtime, instead of Windows' single
 * generic DLL).
 *
 * Extraction shells out to the system `tar` (supports --zstd natively on any GNU tar 1.31+,
 * confirmed present on this dev machine and on GitHub's ubuntu-latest runners) rather than a
 * pure-JS zstd decoder — same approach the Windows Python fetch script already takes for its
 * .tar.gz (shells out to `tar`), just extended to the zstd case jszip can't handle (zip-only).
 *
 * Only touches files under resources/ollama-linux-x64 (gitignored — a fetched asset, not
 * source). Safe to re-run: skips work already done unless --force.
 *
 * Usage: node scripts/fetch-bundled-ollama-linux.mjs [--force]
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

// Pinned release (ollama/ollama) — same tag as the Windows script; update deliberately, not
// casually: re-verify the sha256 from that release's own sha256sum.txt asset when you do.
const OLLAMA_TAG = 'v0.40.3'
const OLLAMA_ASSET = 'ollama-linux-amd64.tar.zst'
const OLLAMA_URL = `https://github.com/ollama/ollama/releases/download/${OLLAMA_TAG}/${OLLAMA_ASSET}`
const OLLAMA_SHA256 = 'ce6f8b671a699bf1ebafb28d60dbbabf4f37b30b499145fa308a8ba72de021d6'

// GPU backends this CPU-only, embedding-only bundle never loads — the bulk of the archive's size.
const EXCLUDED_GLOBS = ['lib/ollama/cuda_v12/*', 'lib/ollama/cuda_v13/*']

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OLLAMA_DIR = path.join(ROOT, 'resources', 'ollama-linux-x64')

const force = process.argv.includes('--force')

function log(msg) {
  console.log(`[fetch-bundled-ollama-linux] ${msg}`)
}

async function fetchOllama() {
  if (!force && existsSync(path.join(OLLAMA_DIR, 'bin', 'ollama'))) {
    log('already present, skipping (use --force to redo)')
    return
  }
  await rm(OLLAMA_DIR, { recursive: true, force: true })
  // tar extracts straight into OLLAMA_DIR (no intermediate rename), so unlike the Python fetch
  // script there's no cross-device-rename hazard — the OS tmpdir is fine for the download.
  const tmp = mkdtempSync(path.join(tmpdir(), 'ollama-dl-'))
  const archive = path.join(tmp, OLLAMA_ASSET)
  try {
    log(`downloading ${OLLAMA_ASSET} (~1.4GB compressed, mostly CUDA backends that get discarded below)…`)
    await download(OLLAMA_URL, archive)
    const actual = await sha256OfFile(archive)
    if (actual !== OLLAMA_SHA256) {
      throw new Error(`checksum mismatch for ${OLLAMA_ASSET}: expected ${OLLAMA_SHA256}, got ${actual}`)
    }
    log('checksum OK, extracting CPU-only subset…')
    await mkdir(OLLAMA_DIR, { recursive: true })
    await execFileAsync('tar', ['--zstd', ...EXCLUDED_GLOBS.flatMap((g) => [`--exclude=${g}`]), '-xf', archive, '-C', OLLAMA_DIR])
    log(`ollama ready at ${path.relative(ROOT, OLLAMA_DIR)} (CUDA backends stripped)`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

fetchOllama().catch((err) => {
  console.error(`[fetch-bundled-ollama-linux] FAILED: ${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
