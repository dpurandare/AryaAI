#!/usr/bin/env node
// Electron 44+ no longer downloads its binary during `npm install` — the
// electron package now fetches it lazily on first `require('electron')`
// instead (node_modules/electron/index.js). electron-vite's own
// getElectronPath() doesn't know about that lazy path and throws "Electron
// uninstall" if node_modules/electron/path.txt isn't already there, so we
// force the download here, in postinstall, before that ever runs.
import 'electron'
