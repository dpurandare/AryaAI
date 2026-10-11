#!/usr/bin/env node
/**
 * Fetches a self-contained Node.js for the Windows sponsor build (TASKS #202), so MCP servers
 * that launch via `npx` (e.g. Context7, the manual-test 13.4 server) work on a genuinely clean
 * Windows machine with no system Node install — found live testing #202 on the sponsor VM
 * (`npx` not on PATH at all).
 *
 * Downloads the official Windows x64 zip, verifies it whole against that release's own
 * SHASUMS256.txt, then extracts everything (node.exe, npm/npx shims, npm's own node_modules)
 * with the top-level `node-vX.Y.Z-win-x64/` folder stripped off. Unlike the Ollama fetch there's
 * no GPU-backend bloat to exclude — the whole thing is wanted. Extraction uses `jszip` (already
 * a project dependency) instead of a shell `unzip`/`tar`, same reasoning as the Ollama script:
 * this runs identically on any host OS regardless of what happens to be on its PATH.
 *
 * Only touches files under resources/node-win-x64 (gitignored — a fetched asset, not source).
 * Safe to re-run: skips work already done unless --force.
 * Runs on any host OS — it only downloads and extracts files, never executes the Windows
 * binaries it fetches.
 *
 * Usage: node scripts/fetch-bundled-node-win.mjs [--force]
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { download, sha256OfFile } from './fetch-utils.mjs'

// Pinned release (nodejs/node) — update deliberately, not casually: re-verify the sha256 from
// that release's own SHASUMS256.txt asset when you do.
const NODE_VERSION = 'v24.21.0'
const NODE_ASSET = `node-${NODE_VERSION}-win-x64.zip`
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ASSET}`
const NODE_SHA256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'

// The zip's single top-level entry — stripped so files land directly under NODE_DIR.
const ARCHIVE_ROOT = `node-${NODE_VERSION}-win-x64/`

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NODE_DIR = path.join(ROOT, 'resources', 'node-win-x64')

const force = process.argv.includes('--force')

function log(msg) {
  console.log(`[fetch-bundled-node-win] ${msg}`)
}

async function fetchNode() {
  if (!force && existsSync(path.join(NODE_DIR, 'node.exe'))) {
    log('already present, skipping (use --force to redo)')
    return
  }
  await rm(NODE_DIR, { recursive: true, force: true })
  // No rename() of the downloaded archive happens below (only jszip reads it and writes new
  // files under NODE_DIR), so like the Ollama fetch and unlike the Python one, there's no
  // cross-device-rename hazard here — the OS tmpdir is fine.
  const tmp = mkdtempSync(path.join(tmpdir(), 'node-dl-'))
  const archive = path.join(tmp, NODE_ASSET)
  try {
    log(`downloading ${NODE_ASSET}…`)
    await download(NODE_URL, archive)
    const actual = await sha256OfFile(archive)
    if (actual !== NODE_SHA256) {
      throw new Error(`checksum mismatch for ${NODE_ASSET}: expected ${NODE_SHA256}, got ${actual}`)
    }
    log('checksum OK, extracting…')
    const zip = await JSZip.loadAsync(await readFile(archive))
    let fileCount = 0
    let byteCount = 0
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir || !name.startsWith(ARCHIVE_ROOT)) continue
      const relative = name.slice(ARCHIVE_ROOT.length)
      if (!relative) continue
      const dest = path.join(NODE_DIR, relative)
      await mkdir(path.dirname(dest), { recursive: true })
      const buf = await entry.async('nodebuffer')
      await writeFile(dest, buf)
      fileCount++
      byteCount += buf.length
    }
    log(`node ready at ${path.relative(ROOT, NODE_DIR)} (${fileCount} files, ${(byteCount / 1024 / 1024).toFixed(0)}MB)`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

fetchNode().catch((err) => {
  console.error(`[fetch-bundled-node-win] FAILED: ${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
