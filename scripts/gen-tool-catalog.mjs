#!/usr/bin/env node
// Generates docs/user-guide/appendix-tool-catalog.md from the REAL tool access of a packaged build, so the
// catalog cannot drift from the code: which tools each specialist holds, and whether a tool changes things
// ("always", "sometimes", "never") come from the running app. The plain-language descriptions are written here;
// a tool the app has that is missing below is listed as "(description to be written)" and reported.
//
//   node scripts/gen-tool-catalog.mjs --app <Sachivji executable> [--out docs/user-guide/appendix-tool-catalog.md]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session } from './docs-screenshots/session.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const DESCRIPTIONS = {
  web_search: 'Searches the web (Tavily when a key is set, otherwise DuckDuckGo) and returns ranked results.',
  parse_html: 'Reads a web page (URL, file or pasted HTML) and returns the clean article text without menus and ads.',
  download_image: 'Downloads images from web addresses into the workspace `resources` folder (up to 5 MB each).',
  find_stock_images: 'Finds free stock photos on a topic, with creator and licence, ready to download.',
  save_research_note: 'Saves a finding with its source while researching.',
  read_research_notes: 'Reads back all saved research notes in order.',
  write_file: 'Creates or overwrites a text file in the workspace.',
  get_environment: 'Tells the assistant about your setup: workspace folders, operating system, today\'s date, Python status.',
  search_history: 'Searches your past conversations (including this one) by meaning and returns excerpts with session and date.',
  read_file: 'Reads a text file.',
  list_directory: 'Lists the files and folders in a directory.',
  find_files: 'Finds files by name pattern under a folder.',
  find_in_files: 'Searches the text inside files (like grep) under a folder.',
  shell_execute: 'Runs a shell command in the workspace.',
  python_run: 'Runs Python code in the workspace\'s own Python environment (charts, data, Word and Excel files).',
  git_exec: 'Runs git commands on the workspace repository (read-only commands need no confirmation).',
  git_clone_repo: 'Clones a different git repository into its own fresh folder, to inspect it.',
  aws_cli: 'Runs the AWS command line tool, if installed and signed in.',
  azure_cli: 'Runs the Azure command line tool, if installed and signed in.',
  gcloud_cli: 'Runs the Google Cloud command line tool, if installed and signed in.',
  github_cli: 'Runs the GitHub command line tool (`gh`) for issues, pull requests and releases.',
  show_media: 'Shows an image from the workspace in the chat.',
  db_list_connections: 'Lists the database connections you configured (never their passwords).',
  db_introspect_schema: 'Lists the tables and columns of a database connection.',
  db_execute_sql: 'Runs SQL on a database connection (anything that changes data asks first).',
  db_list_rows: 'Lists rows of a table, a page at a time, with no SQL needed.',
  db_count_rows: 'Counts the rows of a table.',
  db_find_rows: 'Finds rows where one column equals a value.',
  db_save_query: 'Saves a working query with parameters as a reusable tool for next time.',
  api_list_connections: 'Lists the external API connections you configured.',
  api_introspect: 'Discovers an API\'s endpoints from its OpenAPI/Swagger description.',
  api_call: 'Makes an authenticated call to a configured API (calls that change things ask first).',
  api_check_status: 'Checks on a long-running API job started earlier.',
  parse_csv: 'Summarises and queries a CSV file, and can append a record, without reading the whole file into the chat.',
  parse_json: 'Summarises and queries a JSON document, and can append a record.',
  parse_xml: 'Summarises and queries an XML document.',
  xlsx_read: 'Reads an Excel workbook.',
  xlsx_write: 'Creates or changes an Excel workbook.',
  office_read_document: 'Reads the text of a Word or PowerPoint file.',
  office_create_document: 'Creates a new Word or PowerPoint file from scratch.',
  office_fill_template: 'Fills one of your Word/PowerPoint templates, keeping its styling.',
  office_extract_template: 'Turns an existing document into a reusable template.',
  db_create_connection: 'Sets up a database connection from details you give in chat (the password goes in the confirmation dialog).',
  api_create_connection: 'Sets up an external API connection from details you give in chat.',
  mcp_create_connection: 'Sets up an MCP server connection from details you give in chat.',
  mcp_list_connections: 'Lists your MCP servers, whether each is connected, and the tools each offers.',
  pptx_compose_slide: 'Lays out one slide (text, images, shapes, charts, tables) from a brief.',
  list_email_connections: 'Lists your email accounts (never their secrets).',
  send_email: 'Sends an email from a configured account (always asks first).'
}

const CHANGES = { always: 'Yes, asks first', sometimes: 'Sometimes, asks first', never: 'No' }

function parseArgs(argv) {
  const a = { app: undefined, out: join(root, 'docs/user-guide/appendix-tool-catalog.md') }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app') a.app = resolve(argv[++i])
    else if (argv[i] === '--out') a.out = resolve(argv[++i])
    else throw new Error(`Unknown argument ${argv[i]}`)
  }
  if (!a.app) throw new Error('Usage: node scripts/gen-tool-catalog.mjs --app <Sachivji executable> [--out file]')
  return a
}

const args = parseArgs(process.argv.slice(2))
const work = mkdtempSync(join(tmpdir(), 'sachiv-shots-'))
const s = new Session({ exe: args.app, work, out: work, theme: 'light' })
let roles
try {
  await s.launch()
  await s.waitForText('Welcome to Sachivji')
  roles = JSON.parse(await s.evaluate('window.sachiv.listToolsByRole().then((r) => JSON.stringify(r))'))
} finally {
  await s.shutdown()
  rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 })
}

const missing = new Set()
const lines = [
  '# Appendix: Tool catalog',
  '',
  '<!-- Generated by scripts/gen-tool-catalog.mjs from a running build. Do not edit by hand: change the descriptions in that script and run it again. -->',
  '',
  'Tools are the actions Sachivji can take. Each specialist holds only some of them (see [Agents and roles](05-agents-and-roles.md)). In **Auto** mode the main assistant can use the tools of every specialist directly as well. A tool that "changes things" always asks for your approval first, unless you switched on auto-approve for it.',
  '',
  'The same list, with full descriptions, is in **Settings > Tools by role**.',
  ''
]
for (const r of roles) {
  lines.push(`## ${r.roleLabel}`, '', r.summary, '')
  if (r.tools.length === 0) {
    lines.push('No tools of its own: it only reasons and plans.', '')
    continue
  }
  lines.push('| Tool | What it does | Changes things? |', '|---|---|---|')
  for (const t of r.tools) {
    const d = DESCRIPTIONS[t.name]
    if (!d) missing.add(t.name)
    lines.push(`| \`${t.name}\` | ${d ?? '(description to be written)'} | ${CHANGES[t.mutates] ?? t.mutates} |`)
  }
  lines.push('')
}
lines.push(
  '## Tools that belong to the main assistant',
  '',
  'These are not held by a specialist: the main assistant uses them directly.',
  '',
  '| Tool | What it does |',
  '|---|---|',
  '| `describe_capabilities` | Tells you what the assistant can do, which specialists exist and which connections are configured. |',
  '| `pptx_start_deck`, `pptx_add_slide`, `pptx_save_deck` | Build a PowerPoint presentation one slide at a time, using the Page Creator for each slide. |',
  '| `delegate_to_<specialist>` | Hands a job to a specialist (one per role). |',
  '| Tools of your MCP servers and saved queries | Appear while the matching connection exists. MCP tools belong to the MCP Operator. |',
  ''
)
writeFileSync(args.out, lines.join('\n'))
console.log(`Wrote ${args.out} (${roles.reduce((n, r) => n + r.tools.length, 0)} tool entries)`)
if (missing.size) console.warn(`Descriptions missing for: ${[...missing].join(', ')}`)
