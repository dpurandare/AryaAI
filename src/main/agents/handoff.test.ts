import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  diffSnapshots,
  formatDelegateResult,
  formatInputs,
  HANDOFF_DIR,
  isCapturableDataTool,
  parseHandoffTag,
  pruneHandoffDirs,
  saveHandoffData,
  snapshotWorkspace,
  type DelegateResult
} from './handoff'

describe('parseHandoffTag', () => {
  it('finds needs_input at the end, with the question after it', () => {
    const p = parseHandoffTag('I looked at the file.\n[handoff: needs_input] Which year should the chart cover?')
    expect(p).toMatchObject({ status: 'needs_input', detail: 'Which year should the chart cover?', text: 'I looked at the file.' })
  })

  it('finds out_of_scope with a suggested role, accepting -> and →', () => {
    expect(parseHandoffTag('Not mine.\n[handoff: out_of_scope -> data] needs SQL')).toMatchObject({ status: 'out_of_scope', suggestedRole: 'data', detail: 'needs SQL' })
    expect(parseHandoffTag('Not mine. [handoff: out_of_scope → document-creator]')).toMatchObject({ suggestedRole: 'document-creator' })
  })

  it('is case-tolerant and returns plain text untouched when there is no tag (a model that gives no structure defaults to done)', () => {
    expect(parseHandoffTag('Done. The chart is saved.')).toEqual({ text: 'Done. The chart is saved.' })
    expect(parseHandoffTag('x [HANDOFF: NEEDS_INPUT] why?').status).toBe('needs_input')
  })

  it('ignores a tag that is only quoted earlier in a long reply, not at the end', () => {
    const long = '[handoff: needs_input] is the tag I would use if stuck. ' + 'Finished the work. '.repeat(100)
    expect(parseHandoffTag(long).status).toBeUndefined()
  })

  it('an unknown status word is not a tag', () => {
    expect(parseHandoffTag('hi [handoff: done]').status).toBeUndefined()
  })

  it('finds no_information at the end, with what was searched as the detail (design-discussion.md §13.2(b), TASKS #143)', () => {
    const p = parseHandoffTag('Searched the energy wiki for inverter fault procedures.\n[handoff: no_information] nothing relevant on file')
    expect(p).toMatchObject({ status: 'no_information', detail: 'nothing relevant on file', text: 'Searched the energy wiki for inverter fault procedures.' })
    expect(parseHandoffTag('x [handoff: NO_INFORMATION]').status).toBe('no_information') // case-tolerant, like the other tags
  })
})

describe('workspace snapshots — code-derived artifacts', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sachiv-handoff-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reports files a script created and files it changed, sorted, and nothing else', async () => {
    await mkdir(path.join(root, 'documents'))
    await writeFile(path.join(root, 'documents', 'old.docx'), 'v1')
    await writeFile(path.join(root, 'untouched.txt'), 'same')
    const before = await snapshotWorkspace(root)

    await writeFile(path.join(root, 'documents', 'old.docx'), 'version two, longer')
    await mkdir(path.join(root, 'resources'))
    await writeFile(path.join(root, 'resources', 'chart_1997.png'), 'png')
    await writeFile(path.join(root, 'resources', 'chart_1996.png'), 'png')
    const diff = diffSnapshots(before, await snapshotWorkspace(root))

    expect(diff.created).toEqual(['resources/chart_1996.png', 'resources/chart_1997.png'])
    expect(diff.modified).toEqual(['documents/old.docx'])
    expect(diff.reliable).toBe(true)
  })

  it('catches a same-size rewrite through the mtime', async () => {
    await writeFile(path.join(root, 'a.txt'), 'AAAA')
    const before = await snapshotWorkspace(root)
    await writeFile(path.join(root, 'a.txt'), 'BBBB')
    const future = new Date(Date.now() + 5000)
    await utimes(path.join(root, 'a.txt'), future, future)
    expect(diffSnapshots(before, await snapshotWorkspace(root)).modified).toEqual(['a.txt'])
  })

  it('never scans the venv, node_modules, .git, clones or its own handoff folder (a pip install is not an artifact)', async () => {
    const before = await snapshotWorkspace(root)
    for (const d of ['venv/lib', 'node_modules/x', '.git/objects', '.sachiv-clones/r', `${HANDOFF_DIR}/t`]) {
      await mkdir(path.join(root, d), { recursive: true })
      await writeFile(path.join(root, d, 'f.txt'), 'x')
    }
    expect(diffSnapshots(before, await snapshotWorkspace(root)).created).toEqual([])
  })

  it('marks the diff unreliable when the scan is capped, instead of silently under-reporting', async () => {
    for (let i = 0; i < 5; i++) await writeFile(path.join(root, `f${i}.txt`), 'x')
    const capped = await snapshotWorkspace(root, { maxEntries: 3 })
    expect(capped.truncated).toBe(true)
    expect(diffSnapshots(capped, capped).reliable).toBe(false)
  })

  it('a missing workspace root yields an empty snapshot rather than throwing', async () => {
    const snap = await snapshotWorkspace(path.join(root, 'nope'))
    expect(snap.files.size).toBe(0)
  })
})

describe('saveHandoffData', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sachiv-handoff-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const sqlResult = `30 row(s):\n${JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ Year: 1996 + (i % 3), CustomerID: `C${i}`, TotalSales: i * 100.5 })), null, 2)}`

  it('saves the FULL result to a workspace file and reports its path and size (the D2 fix: rows travel, not a summary)', async () => {
    const saved = await saveHandoffData(root, 'turn1', 1, 'db_execute_sql', sqlResult)
    expect(saved).toEqual({ path: `${HANDOFF_DIR}/turn1/01-db_execute_sql.json`, tool: 'db_execute_sql', summary: '30 rows' })
    const onDisk = await readFile(path.join(root, saved!.path), 'utf-8')
    // Found live (manual_testing.md section 4, Prompt B): the file used to keep the "30 row(s):" chat
    // header, and a later step's script had to skip the first line itself before json.load() — several
    // failed rounds of od -c/head -c to even find that out. The on-disk file is now pure, directly
    // parseable JSON; the row count still reaches the next step, but via its `summary` (above) and the
    // orchestrator's own "Inputs from earlier in this turn" note, never by being embedded in the file.
    expect(onDisk).not.toMatch(/^\d+ row\(s\):/)
    expect(JSON.parse(onDisk)).toHaveLength(30)
  })

  it('uses .txt for non-JSON results and describes them by length', async () => {
    const saved = await saveHandoffData(root, 't', 2, 'parse_html', 'Article text. '.repeat(50))
    expect(saved?.path).toMatch(/02-parse_html\.txt$/)
    expect(saved?.summary).toBe('700 characters')
  })

  it('strips a differently-shaped chat header too — not hardcoded to "N row(s):" (api_call-style "<status> <statusText>\\n<json>")', async () => {
    const body = JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => ({ id: i })) }, null, 2)
    const saved = await saveHandoffData(root, 't', 3, 'api_call', `200 OK\n${body}`)
    expect(saved?.path).toMatch(/03-api_call\.json$/)
    const onDisk = await readFile(path.join(root, saved!.path), 'utf-8')
    expect(onDisk).toBe(body) // header stripped, exact JSON preserved
    expect(JSON.parse(onDisk).items).toHaveLength(20)
  })

  it('falls back to the raw text when nothing after the first bracket is actually valid JSON', async () => {
    const text = 'Some prose mentioning a {set} of things but not actually JSON at all. '.repeat(5)
    const saved = await saveHandoffData(root, 't', 4, 'parse_html', text)
    expect(saved?.path).toMatch(/04-parse_html\.txt$/)
    const onDisk = await readFile(path.join(root, saved!.path), 'utf-8')
    expect(onDisk).toBe(text) // untouched — never silently truncate real text content
  })

  it('skips a result short enough to be fully visible already', async () => {
    expect(await saveHandoffData(root, 't', 1, 'db_execute_sql', '1 row(s):\n[{"n":1}]')).toBeUndefined()
    expect(existsSync(path.join(root, HANDOFF_DIR))).toBe(false)
  })

  it('never throws when the workspace is unwritable — capture is best-effort', async () => {
    await writeFile(path.join(root, 'file.txt'), 'i am a file, not a folder')
    expect(await saveHandoffData(path.join(root, 'file.txt'), 't', 1, 'db_execute_sql', sqlResult)).toBeUndefined()
  })

  it('prunes old handoff folders and keeps recent ones', async () => {
    await saveHandoffData(root, 'old', 1, 'db_execute_sql', sqlResult)
    await saveHandoffData(root, 'new', 1, 'db_execute_sql', sqlResult)
    const old = new Date(Date.now() - 10 * 86_400_000)
    await utimes(path.join(root, HANDOFF_DIR, 'old'), old, old)
    await pruneHandoffDirs(root, 7 * 86_400_000)
    expect(existsSync(path.join(root, HANDOFF_DIR, 'old'))).toBe(false)
    expect(existsSync(path.join(root, HANDOFF_DIR, 'new'))).toBe(true)
  })
})

describe('isCapturableDataTool', () => {
  it('covers data-producing tools and saved-query tools, not file writers or the shell', () => {
    for (const n of ['db_execute_sql', 'db_query_top10_abc', 'parse_csv', 'api_call', 'xlsx_read', 'parse_html', 'web_search']) expect(isCapturableDataTool(n)).toBe(true)
    for (const n of ['write_file', 'shell_execute', 'send_email', 'db_save_query']) expect(isCapturableDataTool(n)).toBe(false)
  })
})

describe('formatDelegateResult / formatInputs', () => {
  const base: DelegateResult = { role: 'coding', status: 'done', summary: 'All done.', artifacts: [], dataFiles: [], isError: false }

  it('is EXACTLY the specialist text when there is nothing to add, so an ordinary reply is unchanged', () => {
    expect(formatDelegateResult(base)).toBe('All done.')
  })

  it('lists app-verified files and captured data', () => {
    const text = formatDelegateResult({
      ...base,
      artifacts: ['resources/chart_1996.png', 'documents/report.docx'],
      dataFiles: [{ path: '.sachiv-handoff/t/01-db_execute_sql.json', tool: 'db_execute_sql', summary: '30 rows' }]
    })
    expect(text).toContain('Files created or changed (verified by the app, not self-reported): resources/chart_1996.png, documents/report.docx')
    expect(text).toContain('Data captured for later steps: .sachiv-handoff/t/01-db_execute_sql.json (db_execute_sql, 30 rows)')
  })

  it('caps a long artifact list', () => {
    const many = Array.from({ length: 30 }, (_, i) => `f${i}.png`)
    expect(formatDelegateResult({ ...base, artifacts: many })).toContain('and 18 more')
  })

  it('tells the router to ask the user on needs_input, and to redirect on out_of_scope', () => {
    expect(formatDelegateResult({ ...base, status: 'needs_input', blocker: 'Which year?' })).toMatch(/NEEDS INPUT.*Which year\?.*do not guess/)
    expect(formatDelegateResult({ ...base, status: 'out_of_scope', suggestedRole: 'data', blocker: 'needs SQL' })).toMatch(/OUT OF SCOPE.*suggested: delegate_to_data/)
    expect(formatDelegateResult({ ...base, status: 'out_of_scope', suggestedRole: 'document-creator' })).toContain('delegate_to_document_creator')
  })

  it('names a no_information result plainly, with what was searched when the specialist gave it (design-discussion.md §13.2(b), TASKS #143)', () => {
    expect(formatDelegateResult({ ...base, status: 'no_information', blocker: 'searched the energy wiki, nothing on inverter faults' })).toMatch(
      /NO INFORMATION FOUND.*searched the energy wiki, nothing on inverter faults/
    )
    expect(formatDelegateResult({ ...base, status: 'no_information' })).toContain('NO INFORMATION FOUND — the connected source(s) had nothing relevant to this request.')
  })

  it('formats inputs for the next brief, capped to the most recent', () => {
    expect(formatInputs([])).toBe('')
    const items = Array.from({ length: 20 }, (_, i) => ({ fromRole: 'data' as const, kind: 'data' as const, path: `p${i}.json`, note: '30 rows' }))
    const text = formatInputs(items)
    expect(text).toMatch(/never invent, assume or retype the data/)
    expect(text).toContain('p19.json')
    expect(text).not.toContain('p0.json')
  })
})
