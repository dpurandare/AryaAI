import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      // Sandboxed preload scripts (webPreferences.sandbox: true) cannot use
      // ES module `import`/`export` syntax at all, regardless of file
      // extension — force CommonJS output so it runs under the sandbox.
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    // Two pages sharing one bundle: `index.html` is the normal app window;
    // `print.html` is a hidden window used only to render a session's
    // transcript for PDF export (see sessions/export.ts) before Electron's
    // webContents.printToPDF() runs against it.
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          print: resolve('src/renderer/print.html')
        }
      }
    },
    plugins: [svelte()]
  }
})
