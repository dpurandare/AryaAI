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
// This re-brands the local dev copy of Electron.app in place. A fresh
// `npm install` restores the stock Electron.app, so it's wired into
// `postinstall` and `predev`/`prestart` to reapply automatically.
import { existsSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

if (process.platform !== 'darwin') process.exit(0)

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const contents = join(root, 'node_modules/electron/dist/Electron.app/Contents')
const plist = join(contents, 'Info.plist')
const icon = join(contents, 'Resources/electron.icns')
const sourceIcon = join(root, 'build/icon.icns')

// Electron may not be installed yet (e.g. this runs from `postinstall`
// mid-`npm install`, before node_modules/electron is fully in place) —
// silently skip rather than fail the install.
if (!existsSync(plist)) process.exit(0)

execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleName Sachivji', plist])
execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleDisplayName Sachivji', plist])
if (existsSync(sourceIcon)) copyFileSync(sourceIcon, icon)
