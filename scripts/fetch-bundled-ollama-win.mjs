#!/usr/bin/env node
/**
 * Fetches a self-contained, CPU-only Ollama for the Windows sponsor build (TASKS #202), so
 * local embeddings work with no manual Ollama install. The embedding model itself is NOT
 * fetched here — it's pulled over the network on first run instead (see the app's onboarding
 * step), so this script only ships the ~66MB CPU runtime, not a multi-hundred-MB model blob.
 *
 * Ollama's official Windows zip bundles CUDA v12/v13 and Vulkan GPU backends alongside the CPU
 * one — about 1.9GB uncompressed, almost all of it GPU DLLs this app never uses (no local chat
 * model is bundled; the embedding model this app needs runs fine on CPU). This script downloads
 * the official zip, verifies it whole against the release's own sha256sum.txt, then extracts
 * only the CPU-relevant subset (ollama.exe plus lib/ollama/* minus cuda_v12/cuda_v13/vulkan) —
 * about 66MB. Extraction uses `jszip` (already a project dependency) instead of a shell `unzip`/
 * `tar` command so this runs identically on any host OS without relying on what happens to be on
 * that machine's PATH — Windows has no `unzip` on PATH by default.
 *
 * Only touches files under resources/ollama-win-x64 (gitignored — a fetched asset, not source).
 * Safe to re-run: skips work already done unless --force.
 * Runs on any host OS — it only downloads and extracts files, never executes the Windows binary
 * it fetches.
 *
 * Usage: node scripts/fetch-bundled-ollama-win.mjs [--force]
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { download, sha256OfFile } from './fetch-utils.mjs'

// Pinned release (ollama/ollama) — update deliberately, not casually: re-verify the sha256 from
// that release's own sha256sum.txt asset when you do.
const OLLAMA_TAG = 'v0.40.3'
const OLLAMA_ASSET = 'ollama-windows-amd64.zip'
const OLLAMA_URL = `https://github.com/ollama/ollama/releases/download/${OLLAMA_TAG}/${OLLAMA_ASSET}`
const OLLAMA_SHA256 = 'e5ecff02dfc7cae8ddf6d6b7a7ac5f727ffeedf4491f44ae75ff5b0820dbbbd5'

// GPU backends this CPU-only, embedding-only bundle never loads — the bulk of the zip's size.
const EXCLUDED_PREFIXES = ['lib/ollama/cuda_v12/', 'lib/ollama/cuda_v13/', 'lib/ollama/vulkan/']

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OLLAMA_DIR = path.join(ROOT, 'resources', 'ollama-win-x64')

const force = process.argv.includes('--force')

function log(msg) {
  console.log(`[fetch-bundled-ollama-win] ${msg}`)
}

async function fetchOllama() {
  if (!force && existsSync(path.join(OLLAMA_DIR, 'ollama.exe'))) {
    log('already present, skipping (use --force to redo)')
    return
  }
  await rm(OLLAMA_DIR, { recursive: true, force: true })
  // No rename() of the downloaded archive happens below (only jszip reads it and writes new
  // files under OLLAMA_DIR), so unlike the Python fetch script there's no cross-device-rename
  // hazard here — the OS tmpdir is fine.
  const tmp = mkdtempSync(path.join(tmpdir(), 'ollama-dl-'))
  const archive = path.join(tmp, OLLAMA_ASSET)
  try {
    log(`downloading ${OLLAMA_ASSET} (~1.4GB, mostly GPU backends that get discarded below)…`)
    await download(OLLAMA_URL, archive)
    const actual = await sha256OfFile(archive)
    if (actual !== OLLAMA_SHA256) {
      throw new Error(`checksum mismatch for ${OLLAMA_ASSET}: expected ${OLLAMA_SHA256}, got ${actual}`)
    }
    log('checksum OK, extracting CPU-only subset…')
    const zip = await JSZip.loadAsync(await readFile(archive))
    let fileCount = 0
    let byteCount = 0
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue
      if (EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
      const dest = path.join(OLLAMA_DIR, name)
      await mkdir(path.dirname(dest), { recursive: true })
      const buf = await entry.async('nodebuffer')
      await writeFile(dest, buf)
      fileCount++
      byteCount += buf.length
    }
    log(`ollama ready at ${path.relative(ROOT, OLLAMA_DIR)} (${fileCount} files, ${(byteCount / 1024 / 1024).toFixed(0)}MB — CUDA/Vulkan backends stripped)`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

fetchOllama().catch((err) => {
  console.error(`[fetch-bundled-ollama-win] FAILED: ${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
