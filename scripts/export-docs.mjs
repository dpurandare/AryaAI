#!/usr/bin/env node
// Joins a documentation folder into ONE file: Markdown, or a PDF printed by Electron (the same
// printToPDF route the chat export uses, so no extra dependency).
//
//   node scripts/export-docs.mjs user|developer [--format md|pdf] [--out <file>]
//
// Pages are docs/<guide>-guide/*.md in file-name order (01-..., 02-..., then appendix-*), README.md
// (the index) excluded. Each page starts with one "# Title" line; the title page and table of contents
// are generated here. Images referenced by relative path are resolved against the guide folder
// for the PDF; in the Markdown output keep the combined file inside that folder if the pages use images.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const GUIDES = {
  user: { dir: 'docs/user-guide', title: 'Sachivji User Guide' },
  developer: { dir: 'docs/developer-guide', title: 'Sachivji Developer Guide' }
}

function parseArgs(argv) {
  const args = { guide: undefined, format: 'md', out: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--format') args.format = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (!a.startsWith('--') && !args.guide) args.guide = a
    else fail(`Unknown argument "${a}".`)
  }
  if (!GUIDES[args.guide]) fail('Usage: node scripts/export-docs.mjs user|developer [--format md|pdf] [--out <file>]')
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

export function buildMarkdown(pages, title, version, date) {
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
  return [`# ${title}`, '', `Version ${version} · generated ${date}`, '', '## Contents', '', ...toc, '', '---', '', body, ''].join('\n')
}

async function toHtml(markdown, title) {
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
    h1:first-of-type { page-break-before: avoid; margin-top: 0; }
    h2 { font-size: 15pt; margin-top: 1.6em; } h3 { font-size: 12.5pt; }
    code { font: 9.5pt ui-monospace, Menlo, Consolas, monospace; background: #f1f1ee; padding: .05em .3em; border-radius: 3px; }
    pre { background: #f1f1ee; padding: .7em .9em; border-radius: 6px; overflow-wrap: anywhere; white-space: pre-wrap; page-break-inside: avoid; }
    pre code { background: none; padding: 0; }
    table { border-collapse: collapse; width: 100%; font-size: 9.5pt; page-break-inside: auto; }
    th, td { border: 1px solid #ccc; padding: .3em .5em; vertical-align: top; text-align: left; }
    tr { page-break-inside: avoid; } th { background: #f1f1ee; }
    blockquote { border-left: 3px solid #bbb; margin-left: 0; padding-left: 1em; color: #444; }
    img { max-width: 100%; } a { color: #1a55b3; text-decoration: none; }`
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head><body>${marked.parse(markdown)}</body></html>`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const guide = GUIDES[args.guide]
  const dir = join(root, guide.dir)
  if (!existsSync(dir)) fail(`Missing ${guide.dir}.`)
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').sort()
  if (files.length === 0) fail(`No pages in ${guide.dir} yet.`)
  const pages = files.map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf-8') }))
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version
  const date = new Date().toISOString().slice(0, 10)
  const markdown = buildMarkdown(pages, guide.title, version, date)
  const base = guide.title.replace(/\s+/g, '-')
  const out = resolve(args.out ?? join(root, 'release', `${base}-${version}.${args.format}`))

  if (args.format === 'md') {
    writeFileSync(out, markdown)
    console.log(`Wrote ${out} (${pages.length} pages)`)
    return
  }
  const work = mkdtempSync(join(tmpdir(), 'sachiv-docs-'))
  const html = join(work, 'guide.html')
  // <base> lets relative image links in the pages resolve against the guide folder.
  writeFileSync(html, (await toHtml(markdown, guide.title)).replace('<head>', `<head><base href="${pathToFileURL(dir + '/').href}">`))
  const electron = require('electron')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const run = spawnSync(electron, [join(root, 'scripts', 'docs-pdf-main.cjs'), html, out, `${guide.title} ${version}`], { stdio: 'inherit', env })
  if (run.status !== 0) fail('PDF rendering failed.')
  console.log(`Wrote ${out} (${pages.length} pages)`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main()
