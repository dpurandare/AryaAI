#!/usr/bin/env node
// Captures the User Guide screenshots (TASKS #92) from a PACKAGED Sachivji build, driven over the
// Chrome DevTools Protocol. Only the app's own window contents are captured (never the desktop), the
// app runs on a THROWAWAY profile + workspace with a fake home folder, and real paths are replaced
// by generic ones in the page before every capture.
//
//   node scripts/docs-screenshots.mjs --app <Sachivji executable> [--out docs/user-guide/images] [--only name,name] [--theme light|dark]
//
// e.g. --app release/mac-arm64/Sachivji.app/Contents/MacOS/Sachivji (after `npm run dist:mac` or an
// unpacked `electron-builder --dir` build). Needs the `sqlite3` command line tool to seed demo data.
// The steps live in scripts/docs-screenshots/*.mjs; each screenshot is one named step.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Session } from './docs-screenshots/session.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const a = { app: undefined, out: join(root, 'docs/user-guide/images'), only: undefined, theme: 'light', keep: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app') a.app = resolve(argv[++i])
    else if (argv[i] === '--out') a.out = resolve(argv[++i])
    else if (argv[i] === '--only') a.only = new Set(argv[++i].split(','))
    else if (argv[i] === '--theme') a.theme = argv[++i]
    else if (argv[i] === '--keep') a.keep = true
    else throw new Error(`Unknown argument ${argv[i]}`)
  }
  if (!a.app) throw new Error('Usage: node scripts/docs-screenshots.mjs --app <Sachivji executable> [--out dir] [--only a,b] [--theme light|dark]')
  return a
}

const args = parseArgs(process.argv.slice(2))
mkdirSync(args.out, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'sachiv-shots-'))
const session = new Session({ exe: args.app, work, out: args.out, theme: args.theme, only: args.only })
try {
  for (const phase of ['first-run', 'main-window', 'settings']) {
    const mod = await import(pathToFileURL(join(root, 'scripts/docs-screenshots', `${phase}.mjs`)).href)
    await mod.run(session)
  }
} finally {
  await session.shutdown()
  if (!args.keep) rmSync(work, { recursive: true, force: true })
  else console.log(`Kept ${work}`)
}
