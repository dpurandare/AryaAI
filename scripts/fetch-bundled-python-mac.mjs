#!/usr/bin/env node
/**
 * Fetches a self-contained Python for the macOS Apple Silicon release (TASKS #208, extending
 * the Windows (#202) and Linux (#207) bundled-runtime approach), so the app needs no system
 * Python at all: a standalone interpreter (python-build-standalone) plus the project's pinned
 * base packages as prebuilt macOS arm64 wheels, so installing them later needs no network either.
 *
 * Apple Silicon only for now (Intel Mac deliberately deferred — see TASKS #208): uses the
 * `aarch64-apple-darwin` build, not `x86_64-apple-darwin`.
 *
 * Only touches files under resources/python-mac-arm64 and resources/python-mac-arm64-wheels
 * (both gitignored — these are fetched assets, not source). Safe to re-run: skips work already
 * done unless --force.
 *
 * Usage: node scripts/fetch-bundled-python-mac.mjs [--force]
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { download, sha256OfFile } from './fetch-utils.mjs'

const execFileAsync = promisify(execFile)

// Pinned release (astral-sh/python-build-standalone tag 20261009) — same tag as the Windows/
// Linux scripts; update deliberately, not casually: re-verify the sha256 from that release's
// SHA256SUMS asset when you do.
const PBS_TAG = '20261009'
const PBS_ASSET = `cpython-3.12.15+${PBS_TAG}-aarch64-apple-darwin-install_only_stripped.tar.gz`
const PBS_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_ASSET}`
const PBS_SHA256 = '233f8e15255b3e1d1fd47ea5dd5230dfed803f371138e896e54d98c60ae19f6f'

// Keep this the same list as BASE_PACKAGES in src/main/runtime/workspace-runtime.ts (and the
// Windows/Linux fetch scripts) — not imported from there on purpose, so this script has no
// dependency on the app's TS build / path aliases and can run with plain `node`.
const BASE_PACKAGES = ['matplotlib==3.10.9', 'numpy==2.2.6', 'pillow==12.3.0', 'python-docx==1.2.0', 'openpyxl==3.1.5']
const WHEEL_PYTHON_VERSION = '3.12'
const WHEEL_ABI = 'cp312'
const WHEEL_PLATFORM = 'macosx_11_0_arm64'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PYTHON_DIR = path.join(ROOT, 'resources', 'python-mac-arm64')
const WHEELHOUSE_DIR = path.join(ROOT, 'resources', 'python-mac-arm64-wheels')

const force = process.argv.includes('--force')

function log(msg) {
  console.log(`[fetch-bundled-python-mac] ${msg}`)
}

async function fetchInterpreter() {
  if (!force && existsSync(path.join(PYTHON_DIR, 'bin', 'python3'))) {
    log('interpreter already present, skipping (use --force to redo)')
    return
  }
  await rm(PYTHON_DIR, { recursive: true, force: true })
  // Extracted under resources/ (not the OS tmpdir) so the final rename() below stays on one
  // filesystem — same cross-device-rename hazard as the Windows/Linux scripts' comments describe.
  await mkdir(path.join(ROOT, 'resources'), { recursive: true })
  const tmp = mkdtempSync(path.join(ROOT, 'resources', '.pbs-'))
  const archive = path.join(tmp, PBS_ASSET)
  try {
    log(`downloading ${PBS_ASSET}…`)
    await download(PBS_URL, archive)
    const actual = await sha256OfFile(archive)
    if (actual !== PBS_SHA256) {
      throw new Error(`checksum mismatch for ${PBS_ASSET}: expected ${PBS_SHA256}, got ${actual}`)
    }
    log('checksum OK, extracting…')
    const extractDir = path.join(tmp, 'extract')
    await mkdir(extractDir, { recursive: true })
    await execFileAsync('tar', ['-xzf', archive, '-C', extractDir])
    // The archive's top-level entry is "python/" — move its contents up to PYTHON_DIR.
    await mkdir(PYTHON_DIR, { recursive: true })
    const extracted = path.join(extractDir, 'python')
    for (const entry of await readdir(extracted)) {
      await rename(path.join(extracted, entry), path.join(PYTHON_DIR, entry))
    }
    log(`interpreter ready at ${path.relative(ROOT, PYTHON_DIR)}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

async function findDriverPython() {
  for (const candidate of [
    ['python3', []],
    ['python', []]
  ]) {
    try {
      await execFileAsync(candidate[0], [...candidate[1], '--version'])
      return candidate
    } catch {
      // try the next one
    }
  }
  throw new Error('no local python3/python found to drive `pip download` (only used to resolve wheels, not executed as the target interpreter)')
}

async function fetchWheelhouse() {
  const already = existsSync(WHEELHOUSE_DIR) && (await readdir(WHEELHOUSE_DIR)).some((f) => f.endsWith('.whl'))
  if (!force && already) {
    log('wheelhouse already present, skipping (use --force to redo)')
    return
  }
  await rm(WHEELHOUSE_DIR, { recursive: true, force: true })
  await mkdir(WHEELHOUSE_DIR, { recursive: true })
  const [cmd, baseArgs] = await findDriverPython()
  log(`resolving ${BASE_PACKAGES.length} pinned packages (+ their deps) as ${WHEEL_PLATFORM}/${WHEEL_ABI} wheels…`)
  await execFileAsync(
    cmd,
    [
      ...baseArgs,
      '-m',
      'pip',
      'download',
      '--no-cache-dir',
      '--only-binary=:all:',
      '--platform',
      WHEEL_PLATFORM,
      '--python-version',
      WHEEL_PYTHON_VERSION,
      '--implementation',
      'cp',
      '--abi',
      WHEEL_ABI,
      '-d',
      WHEELHOUSE_DIR,
      ...BASE_PACKAGES
    ],
    { maxBuffer: 32 * 1024 * 1024 }
  )
  const wheels = (await readdir(WHEELHOUSE_DIR)).filter((f) => f.endsWith('.whl'))
  log(`wheelhouse ready: ${wheels.length} wheels in ${path.relative(ROOT, WHEELHOUSE_DIR)}`)
}

async function main() {
  await fetchInterpreter()
  await fetchWheelhouse()
}

main().catch((err) => {
  console.error(`[fetch-bundled-python-mac] FAILED: ${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
