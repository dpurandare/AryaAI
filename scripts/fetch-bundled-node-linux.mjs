#!/usr/bin/env node
/**
 * Fetches a self-contained Node.js for the Linux release (TASKS #207, extending the Windows
 * sponsor-build approach from #202), so MCP servers that launch via `npx` (e.g. Context7) work
 * with no system Node install.
 *
 * Downloads the official Linux x64 tar.gz, verifies it whole against that release's own
 * SHASUMS256.txt, then extracts everything (node, npm/npx shims, npm's own node_modules) with
 * the top-level `node-vX.Y.Z-linux-x64/` folder stripped via `tar --strip-components=1`.
 * Shells out to the system `tar` — same reasoning as the Ollama fetch script: a pure-JS zip
 * decoder (jszip) doesn't apply here since this is a .tar.gz, and `tar` is always present on the
 * Linux hosts (this dev machine, GitHub's ubuntu-latest runners) this script actually runs on.
 *
 * Only touches files under resources/node-linux-x64 (gitignored — a fetched asset, not source).
 * Safe to re-run: skips work already done unless --force.
 *
 * Usage: node scripts/fetch-bundled-node-linux.mjs [--force]
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

// Pinned release (nodejs/node) — same version as the Windows script; update deliberately, not
// casually: re-verify the sha256 from that release's own SHASUMS256.txt asset when you do.
const NODE_VERSION = 'v24.21.0'
const NODE_ASSET = `node-${NODE_VERSION}-linux-x64.tar.gz`
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ASSET}`
const NODE_SHA256 = '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NODE_DIR = path.join(ROOT, 'resources', 'node-linux-x64')

const force = process.argv.includes('--force')

function log(msg) {
  console.log(`[fetch-bundled-node-linux] ${msg}`)
}

async function fetchNode() {
  if (!force && existsSync(path.join(NODE_DIR, 'bin', 'node'))) {
    log('already present, skipping (use --force to redo)')
    return
  }
  await rm(NODE_DIR, { recursive: true, force: true })
  // tar extracts straight into NODE_DIR (no intermediate rename), so like the Ollama fetch and
  // unlike the Python one, there's no cross-device-rename hazard — the OS tmpdir is fine.
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
    await mkdir(NODE_DIR, { recursive: true })
    await execFileAsync('tar', ['-xzf', archive, '--strip-components=1', '-C', NODE_DIR])
    log(`node ready at ${path.relative(ROOT, NODE_DIR)}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

fetchNode().catch((err) => {
  console.error(`[fetch-bundled-node-linux] FAILED: ${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
