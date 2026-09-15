#!/usr/bin/env node
// Cosmetic, dev-only fix: `npm run dev` / `npm start` launch the raw
// Electron binary straight out of node_modules, whose own Info.plist says
// "Electron" — Electron has no JS API to override the macOS menu-bar app
// name or the bundle-level icon baked into that binary (app.setName() /
// app.dock.setIcon() in src/main/index.ts only affect app.getName(), menu
// *item* labels like "Quit Sachivji", and the already-shown Dock icon
// image — not the bold app name next to the Apple logo, which macOS reads
// straight from the running bundle's Info.plist). The packaged app is
// unaffected by any of this — electron-builder generates its own real
// Info.plist from `productName`/`build/icon.icns` (electron-builder.yml).
//
// CFBundleName/CFBundleDisplayName/CFBundleExecutable are NOT what the
// Dock's own hover-tooltip reads, confirmed live via a real cursor hover +
// screenshot (System Events' AX name/displayed-name properties for a Dock
// tile are unreliable and were NOT trusted as a proxy for this — see the
// project memory for why). Isolated by testing two disposable copies of
// this same Electron.app side by side: one with only its *.app bundle
// folder* renamed (nothing else touched, stock ad-hoc code signature kept)
// showed the new name correctly in a real Dock hover; a separate copy with
// the bundle folder left as "Electron.app" but re-signed with a custom
// identifier still showed "Electron". So the tooltip reads the bundle
// folder's own filename on disk — nothing else. This renames that folder
// itself (Electron.app -> Sachivji.app) and keeps
// node_modules/electron/path.txt (which `require('electron')` reads to
// find the binary to spawn — used by both node_modules/.bin/electron and
// electron-vite) pointed at the new path.
//
// The actual executable file at Contents/MacOS and CFBundleExecutable are
// deliberately left as the stock "Electron" — an EARLIER version of this
// script renamed those too (to fix the Dock's process-name display, a
// separate thing from the tooltip), which turned out to be a real,
// serious regression found and reverted the same day: Electron's own
// `app.isPackaged` getter (lib/browser/api/app.ts upstream) is computed as
// `path.basename(process.execPath).toLowerCase() !== 'electron'` — a
// literal, hardcoded string comparison against the executable's filename,
// nothing configurable. Renaming that file made `app.isPackaged` (and so
// `is.dev` from @electron-toolkit/utils, `!app.isPackaged`) evaluate
// `true` even for this raw unpackaged dev binary, which silently broke
// `npm run dev`'s renderer routing: `src/main/index.ts` only calls
// `loadURL(ELECTRON_RENDERER_URL)` (the live Vite dev server, with HMR)
// when `is.dev` is true, so every dev launch fell through to
// `loadFile(...out/renderer/index.html)` instead — a real but *stale*
// prebuilt bundle, so the app still looked and mostly worked fine, while
// silently never reflecting any renderer source change, with no error
// anywhere. Confirmed by checking the live process's own environment
// (`ELECTRON_RENDERER_URL` was correctly set — the bug was `is.dev` being
// wrong, not the dev server) and by checking @electron-toolkit/utils'
// compiled source directly. If `npm run dev` ever again seems to ignore
// renderer changes with zero errors, check this exact thing first:
// `path.basename(process.execPath)` must still read literally "Electron"
// for an unpackaged dev run, whatever the Dock/bundle-folder branding is.
import { existsSync, copyFileSync, renameSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

if (process.platform !== 'darwin') process.exit(0)

const APP_NAME = 'Sachivji'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const electronPkgDir = join(root, 'node_modules/electron')
const distDir = join(electronPkgDir, 'dist')
const stockAppDir = join(distDir, 'Electron.app')
const appDir = join(distDir, `${APP_NAME}.app`)
const contents = join(appDir, 'Contents')
const plist = join(contents, 'Info.plist')
const icon = join(contents, 'Resources/electron.icns')
const sourceIcon = join(root, 'build/icon.icns')
const pathFile = join(electronPkgDir, 'path.txt')

// Electron may not be installed yet (e.g. this runs from `postinstall`
// mid-`npm install`, before node_modules/electron is fully in place) —
// silently skip rather than fail the install.
if (!existsSync(stockAppDir) && !existsSync(appDir)) process.exit(0)

// Idempotent: only rename if still the stock bundle folder (a second run
// after this already applied would otherwise fail trying to rename a
// folder that no longer exists under its original name).
if (existsSync(stockAppDir)) renameSync(stockAppDir, appDir)
// The executable's own filename inside the bundle never changes (see the
// app.isPackaged comment above) — only where the bundle folder lives.
writeFileSync(pathFile, `${APP_NAME}.app/Contents/MacOS/Electron`)

execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleName ${APP_NAME}`, plist])
execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleDisplayName ${APP_NAME}`, plist])
if (existsSync(sourceIcon)) copyFileSync(sourceIcon, icon)

// The bundle folder's own name/path is what LaunchServices indexes for
// this Dock tile — force it to re-read the renamed bundle now rather than
// leaving a stale entry pointing at the old path until some unrelated
// LS-triggering event happens to refresh it.
const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
try {
  execFileSync(lsregister, ['-f', appDir])
} catch {
  // Best-effort — a missing/relocated lsregister binary shouldn't fail the install.
}
