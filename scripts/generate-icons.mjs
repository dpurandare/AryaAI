// Regenerates build/icon.icns, build/icon.ico, and build/icon.png from
// build/icon-source.png. Run after changing the source icon:
//   npm run icons:generate
//
// Source is a raster PNG, not hand-drawn SVG, unlike this project's earlier
// icon attempts — icon-gen accepts PNG input directly (confirmed: its own
// package.json describes it as "Generate an icon files from the SVG or PNG
// files"), and a raster source is the right choice here since the actual
// artwork (painterly gradients/shading) isn't vector-appropriate content in
// the first place. Already 1024x1024 (the largest size any target needs),
// so every generated size is a downscale, never an upscale — no blur risk.
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import icongen from 'icon-gen'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const buildDir = join(__dirname, '../build')
const source = join(buildDir, 'icon-source.png')

await icongen(source, buildDir, {
  report: true,
  ico: { name: 'icon' },
  icns: { name: 'icon' }
})

// Linux (and a generic large PNG) follow electron-builder's build/icon.png convention.
await sharp(source).resize(1024, 1024).png().toFile(join(buildDir, 'icon.png'))

console.log('Generated build/icon.icns, build/icon.ico, build/icon.png')
