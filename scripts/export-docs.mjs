#!/usr/bin/env node
// Joins a documentation folder into ONE file: Markdown, or a PDF printed by Electron (the same
// printToPDF route the chat export uses, so no extra dependency).
//
//   node scripts/export-docs.mjs user|developer [--format md|pdf] [--out <file>] [--allow-missing-images]
//
// The PDF opens with a cover page (the splash illustration from docs/assets and the app icon from build/icons, the guide name, version and date), then the
// contents, the chapters, and a closing "Index" chapter that is a placeholder for now. The Markdown output has a
// plain title block, the contents, the chapters and the same Index placeholder.
//
// Pages are docs/<guide>-guide/*.md in file-name order (01-..., 02-..., then appendix-*), README.md
// (the index) excluded. Each page starts with one "# Title" line; the title page and table of contents
// are generated here. Screenshots are plain Markdown images with a path relative to the page
// (`![alt](images/name.png)`). The export fails when a referenced image file does not exist (so a
// missing screenshot cannot slip into a shared document); --allow-missing-images only warns.
// PDF: images are embedded. Markdown: the images are copied to `<output name>-images/` next to the
// output file and the links rewritten, unless the output file sits in the guide folder itself.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const GUIDES = {
  user: { dir: 'docs/user-guide', title: 'Sachivji User Guide' },
  developer: { dir: 'docs/developer-guide', title: 'Sachivji Developer Guide' }
}

function parseArgs(argv) {
  const args = { guide: undefined, format: 'md', out: undefined, allowMissingImages: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--format') args.format = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--allow-missing-images') args.allowMissingImages = true
    else if (!a.startsWith('--') && !args.guide) args.guide = a
    else fail(`Unknown argument "${a}".`)
  }
  if (!GUIDES[args.guide]) fail('Usage: node scripts/export-docs.mjs user|developer [--format md|pdf] [--out <file>] [--allow-missing-images]')
  if (args.format !== 'md' && args.format !== 'pdf') fail('--format must be md or pdf.')
  return args
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

/** GitHub-style heading anchor, so the generated table of contents works in both outputs. */
export function slug(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-')
}

/** Headings (levels 1-2) of one page, ignoring anything inside fenced code. */
export function headingsOf(markdown) {
  const out = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    if (fenced) continue
    const m = /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) out.push({ level: m[1].length, text: m[2] })
  }
  return out
}


const IMAGE_REF = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s]+))(\s+"[^"]*")?\s*\)/g
const isRemote = (target) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)

/** Local image references in one page, outside fenced code: `{ alt, target }` with the target as written. */
export function imageRefs(markdown) {
  const refs = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    if (fenced) continue
    for (const m of line.matchAll(IMAGE_REF)) {
      const target = m[2] ?? m[3]
      if (!isRemote(target)) refs.push({ alt: m[1], target: decodeURI(target) })
    }
  }
  return refs
}

/** Rewrites each local image target through `rewrite(target)`; fenced code is left alone. */
export function rewriteImageTargets(markdown, rewrite) {
  let fenced = false
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
      if (fenced) return line
      return line.replace(IMAGE_REF, (whole, alt, angled, bare, title = '') => {
        const target = angled ?? bare
        return isRemote(target) ? whole : `![${alt}](${encodeURI(rewrite(decodeURI(target)))}${title})`
      })
    })
    .join('\n')
}

/** The closing "Index" chapter. A placeholder for now: the real index of terms comes later. */
export const INDEX_PAGE = {
  file: 'index',
  text: '# Index\n\n*The index of terms and page numbers will be added here in a later version of this guide.*\n'
}

/**
 * `titleBlock: false` leaves out the plain title and version lines (the PDF has a designed cover page instead).
 * `indexPlaceholder: false` leaves out the closing Index chapter.
 */
export function buildMarkdown(pages, title, version, date, { titleBlock = true, indexPlaceholder = true } = {}) {
  if (indexPlaceholder) pages = [...pages, INDEX_PAGE]
  const toc = []
  const seen = new Map()
  const anchor = (text) => {
    const base = slug(text)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}-${n}`
  }
  for (const page of pages) {
    for (const h of headingsOf(page.text)) {
      toc.push(`${h.level === 1 ? '' : '  '}- [${h.text}](#${anchor(h.text)})`)
    }
  }
  const body = pages.map((p) => p.text.trim()).join('\n\n---\n\n')
  const head = titleBlock ? [`# ${title}`, '', `Version ${version} · generated ${date}`, ''] : []
  return [...head, '## Contents', '', ...toc, '', '---', '', body, ''].join('\n')
}

async function toHtml(markdown, title, coverHtml = '') {
  const { Marked } = await import('marked')
  const seen = new Map()
  const marked = new Marked({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens)
        const base = slug(inner)
        const n = seen.get(base) ?? 0
        seen.set(base, n + 1)
        return `<h${depth} id="${n === 0 ? base : `${base}-${n}`}">${inner}</h${depth}>\n`
      }
    }
  })
  const css = `
    body { font: 11pt/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1c1c1c; max-width: 46rem; margin: 0 auto; }
    h1 { font-size: 22pt; margin-top: 2.2em; page-break-before: always; border-bottom: 1px solid #ccc; padding-bottom: .2em; }
    .cover { page-break-after: always; text-align: center; padding-top: 20vh; }
    .cover img.illustration { width: 260px; height: 260px; border-radius: 28px; box-shadow: 0 6px 24px rgba(0,0,0,.18); }
    .cover img.icon { width: 44px; height: 44px; border-radius: 10px; vertical-align: middle; margin-right: .6rem; }
    .cover .product { font-size: 40pt; font-weight: 700; margin: 1.2rem 0 .2rem; letter-spacing: -.5px; }
    .cover .guide { font-size: 20pt; color: #444; margin: 0 0 .4rem; }
    .cover .tagline { font-size: 12pt; color: #666; margin: 0 0 2.4rem; }
    .cover .version { font-size: 14pt; font-weight: 600; margin: 0; }
    .cover .date { font-size: 10pt; color: #777; margin: .3rem 0 0; }
    h2 { font-size: 15pt; margin-top: 1.6em; } h3 { font-size: 12.5pt; }
    code { font: 9.5pt ui-monospace, Menlo, Consolas, monospace; background: #f1f1ee; padding: .05em .3em; border-radius: 3px; }
    pre { background: #f1f1ee; padding: .7em .9em; border-radius: 6px; overflow-wrap: anywhere; white-space: pre-wrap; page-break-inside: avoid; }
    pre code { background: none; padding: 0; }
    table { border-collapse: collapse; width: 100%; font-size: 9.5pt; page-break-inside: auto; }
    th, td { border: 1px solid #ccc; padding: .3em .5em; vertical-align: top; text-align: left; }
    tr { page-break-inside: avoid; } th { background: #f1f1ee; }
    blockquote { border-left: 3px solid #bbb; margin-left: 0; padding-left: 1em; color: #444; }
    h2, h3, h4 { break-after: avoid; } img { max-width: 100%; max-height: 23cm; break-inside: avoid; } a { color: #1a55b3; text-decoration: none; }`
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head><body>${coverHtml}${marked.parse(markdown)}</body></html>`
}

/** The PDF's front page: the splash illustration, then the small app icon beside the product name, the guide name, the tagline, the version and the date. */
export function coverHtml({ productName, guideName, tagline, version, date, iconDataUri, illustrationDataUri = '' }) {
  return `<section class="cover">${illustrationDataUri ? `<img class="illustration" src="${illustrationDataUri}" alt="${productName}">` : ''}
<p class="product">${iconDataUri ? `<img class="icon" src="${iconDataUri}" alt="${productName} icon">` : ''}${productName}</p><p class="guide">${guideName}</p><p class="tagline">${tagline}</p>
<p class="version">Version ${version}</p><p class="date">${date}</p></section>`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const guide = GUIDES[args.guide]
  const dir = join(root, guide.dir)
  if (!existsSync(dir)) fail(`Missing ${guide.dir}.`)
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').sort()
  if (files.length === 0) fail(`No pages in ${guide.dir} yet.`)
  const pages = files.map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf-8') }))

  // Every referenced screenshot must exist, so a missing one cannot slip into a shared document.
  const missing = []
  for (const page of pages) {
    for (const { target } of imageRefs(page.text)) {
      if (!existsSync(resolve(dir, target))) missing.push(`${page.file}: ${target}`)
    }
  }
  if (missing.length > 0) {
    const report = `Missing image file${missing.length === 1 ? '' : 's'}:\n  ${missing.join('\n  ')}`
    if (args.allowMissingImages) console.warn(`Warning: ${report}`)
    else fail(`${report}\n(Add the files, or pass --allow-missing-images to export anyway.)`)
  }

  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version
  const date = new Date().toISOString().slice(0, 10)
  const base = guide.title.replace(/\s+/g, '-')
  const out = resolve(args.out ?? join(root, 'release', `${base}-${version}.${args.format}`))
  mkdirSync(dirname(out), { recursive: true })

  if (args.format === 'md') {
    let imagePages = pages
    if (dirname(out) !== dir) {
      // The joined file lives elsewhere: copy the screenshots next to it and point the links there.
      const folderName = `${basename(out).replace(/\.[^.]+$/, '')}-images`
      const target = join(dirname(out), folderName)
      const used = new Map()
      imagePages = pages.map((page) => ({
        ...page,
        text: rewriteImageTargets(page.text, (t) => {
          const source = resolve(dir, t)
          if (!existsSync(source)) return t
          if (!used.has(source)) {
            let name = basename(source)
            while ([...used.values()].includes(name)) name = `${used.size}-${basename(source)}`
            mkdirSync(target, { recursive: true })
            copyFileSync(source, join(target, name))
            used.set(source, name)
          }
          return `${folderName}/${used.get(source)}`
        })
      }))
    }
    writeFileSync(out, buildMarkdown(imagePages, guide.title, version, date))
    console.log(`Wrote ${out} (${pages.length} pages)`)
    return
  }
  const markdown = buildMarkdown(pages, guide.title, version, date, { titleBlock: false })
  const iconPath = join(root, 'build', 'icons', '512x512.png')
  const illustrationPath = join(root, 'docs', 'assets', 'cover-illustration.png')
  const dataUri = (path) => (existsSync(path) ? `data:image/png;base64,${readFileSync(path).toString('base64')}` : '')
  const cover = coverHtml({
    productName: 'Sachivji',
    guideName: guide.title.replace(/^Sachivji\s+/, ''),
    tagline: 'Your local-first, multi-agent AI companion.',
    version,
    date,
    iconDataUri: dataUri(iconPath),
    illustrationDataUri: dataUri(illustrationPath)
  })
  const work = mkdtempSync(join(tmpdir(), 'sachiv-docs-'))
  const html = join(work, 'guide.html')
  // <base> lets relative image links in the pages resolve against the guide folder.
  writeFileSync(html, (await toHtml(markdown, guide.title, cover)).replace('<head>', `<head><base href="${pathToFileURL(dir + '/').href}">`))
  const electron = require('electron')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const run = spawnSync(electron, [join(root, 'scripts', 'docs-pdf-main.cjs'), html, out, `${guide.title} ${version}`], { stdio: 'inherit', env })
  if (run.status !== 0) fail('PDF rendering failed.')
  console.log(`Wrote ${out} (${pages.length} pages)`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main()
