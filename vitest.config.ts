import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Vitest doesn't read tsconfig paths automatically (no vite-tsconfig-paths
// plugin here), so the @shared alias — already declared in tsconfig.node.json
// and electron.vite.config.ts — has to be repeated explicitly.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    setupFiles: ['test/support/no-docx-framing.ts']
  }
})
