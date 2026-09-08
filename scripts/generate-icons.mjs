// Regenerates build/icon.icns, build/icon.ico, and build/icon.png from
// build/icon-source.svg. Run after changing the source icon:
//   npm run icons:generate
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import icongen from 'icon-gen'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const buildDir = join(__dirname, '../build')
const source = join(buildDir, 'icon-source.svg')

await icongen(source, buildDir, {
  report: true,
  ico: { name: 'icon' },
  icns: { name: 'icon' }
})

// Linux (and a generic large PNG) follow electron-builder's build/icon.png convention.
await sharp(source).resize(1024, 1024).png().toFile(join(buildDir, 'icon.png'))

console.log('Generated build/icon.icns, build/icon.ico, build/icon.png')
