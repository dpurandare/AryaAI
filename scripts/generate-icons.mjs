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
import { mkdir } from 'node:fs/promises'
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

// Linux desktop environments (taskbar, app switcher, window decoration) each ask for a
// specific size from the installed hicolor icon theme — found live (TASKS #207/#209) that
// electron-builder's "resize a single build/icon.png automatically" path only ever produced
// the 1024x1024 bucket in the packaged .deb (`dpkg -c` showed just one size under
// usr/share/icons/hicolor/), so most UI contexts fell back to a generic icon instead of
// resizing it themselves. electron-builder's documented, reliable alternative is a
// `build/icons/` directory with one file per size, named `<size>x<size>.png` — generating
// those ourselves (same sharp instance, all downscales from the 1024x1024 source, no blur
// risk) sidesteps relying on electron-builder's own resize step at all.
const iconsDir = join(buildDir, 'icons')
await mkdir(iconsDir, { recursive: true })
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  await sharp(source)
    .resize(size, size)
    .png()
    .toFile(join(iconsDir, `${size}x${size}.png`))
}

console.log('Generated build/icon.icns, build/icon.ico, build/icon.png, build/icons/{16,24,32,48,64,128,256,512,1024}x*.png')
