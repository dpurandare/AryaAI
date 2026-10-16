#!/usr/bin/env node
// Renders every docs/developer-guide/diagrams/*.mmd (Mermaid) to docs/developer-guide/images/<name>.png.
// Needs Google Chrome (headless) and the `mermaid` package from node_modules. Run after editing a diagram.
//   node scripts/render-diagrams.mjs [name ...]
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'docs', 'developer-guide', 'diagrams')
const outDir = join(root, 'docs', 'developer-guide', 'images')
const chrome = process.env.CHROME || 'google-chrome'
const mermaidJs = pathToFileURL(join(root, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')).href
const only = process.argv.slice(2)
import { mkdirSync } from 'node:fs'
mkdirSync(outDir, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'sachiv-diagrams-'))

for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.mmd'))) {
  const name = file.replace(/\.mmd$/, '')
  if (only.length && !only.includes(name)) continue
  const code = readFileSync(join(srcDir, file), 'utf8')
  const page = join(work, `${name}.html`)
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff"><div id="o"></div>
<script src="${mermaidJs}"></script><script>
mermaid.initialize({ startOnLoad: false, theme: 'neutral', flowchart: { htmlLabels: true, useMaxWidth: false }, sequence: { useMaxWidth: false } })
mermaid.render('g', ${JSON.stringify(code)}).then(({ svg }) => { document.getElementById('o').innerHTML = svg; document.title = 'done' })
</script>`)
  // First pass: measure the rendered SVG.
  const dom = execFileSync(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=8000', '--dump-dom', pathToFileURL(page).href], { encoding: 'utf8', maxBuffer: 64e6 })
  const m = dom.match(/<svg[^>]*viewBox="([\d.\-]+) ([\d.\-]+) ([\d.]+) ([\d.]+)"/)
  if (!m) throw new Error(`${name}: mermaid did not render (check the syntax)`)
  const w = Math.ceil(+m[3]) + 2, h = Math.ceil(+m[4]) + 2
  execFileSync(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', `--window-size=${w},${h}`, '--virtual-time-budget=8000', `--screenshot=${join(outDir, name + '.png')}`, pathToFileURL(page).href], { stdio: 'ignore' })
  console.log(`rendered ${name}.png (${w}x${h})`)
}
rmSync(work, { recursive: true, force: true })
