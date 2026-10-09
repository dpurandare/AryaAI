import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { WORKSPACE_VENV_DIR, withWorkspaceVenv, workspaceVenvBinDir } from './python-env'
import { diffSnapshots, snapshotWorkspace } from './workspace-snapshot'
import { SCRATCH_DIR, tidyRootStrays } from './workspace-layout'
import type { Tool, ToolContext } from './types'

/**
 * `python_run` — run a Python script in the workspace's virtual environment
 * (design-discussion.md 4.3, Track A4). Built from what the Northwind chart sessions
 * (Appendix D1/D2) showed going wrong with a bare shell:
 *
 *  - **No shell quoting.** The model sent Python through `python -c "…; with …; for …"` (a
 *    syntax error: compound statements cannot follow a semicolon) and then pasted multi-line
 *    source as the shell command, ~10 near-identical failures in a row. This tool takes a
 *    script path or the source itself as a parameter and launches the interpreter directly
 *    (`execFile`, no shell), so there is nothing to quote or escape.
 *  - **The interpreter is resolved here**, never guessed (`python` vs `python3`, venv vs
 *    system): it is always `<workspace>/venv`'s python, or a clear reason why not.
 *  - **It reports what it produced.** The files created or changed are found by diffing the
 *    workspace around the run — derived in code, not claimed by the model — which is exactly
 *    the `artifacts` field of the handoff contract (5.1).
 *
 * A venv isolates packages, not the filesystem: this is NOT a sandbox (a script can read and
 * write anywhere the user can). The confirmation dialog, which shows the code that will run,
 * is the safety boundary.
 */

const DEFAULT_TIMEOUT_S = 120
const MAX_TIMEOUT_S = 600
const MAX_BUFFER_BYTES = 10_000_000
/** Per stream, in the returned text. The tail is kept: the traceback is at the end. */
const MAX_OUTPUT_CHARS = 20_000
const DESCRIBE_PREVIEW_CHARS = 2_000
const MAX_LISTED_FILES = 20

function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `[…${text.length - MAX_OUTPUT_CHARS} earlier characters omitted…]\n${text.slice(-MAX_OUTPUT_CHARS)}` : text
}

function stamp(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

/** The venv interpreter, or a message saying why there isn't one. Also honours the runtime state (off / still creating / failed). */
function resolveInterpreter(ctx: ToolContext): { python: string } | { error: string } {
  const state = ctx.runtimeState?.()
  if (state?.status === 'disabled') {
    return { error: 'Python is turned off (Settings > Runtime > Turn Python on). Tell the user; do not try to work around it.' }
  }
  if (state?.status === 'creating') {
    return { error: 'The Python environment is still being set up. Try again in a minute (progress: Settings > Runtime).' }
  }
  const root = ctx.workspaceGuard.root
  const bin = workspaceVenvBinDir(root)
  if (!bin) {
    const why = state && (state.status === 'missing-python' || state.status === 'failed') ? ` ${state.message}` : ''
    return { error: `This workspace has no usable Python environment (${WORKSPACE_VENV_DIR}/).${why} Tell the user to open Settings > Runtime and choose Retry — do not try to install Python or build a venv yourself.` }
  }
  return { python: path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python') }
}

/**
 * python-pptx used to START a new presentation (`Presentation()` with no file) and save it as .pptx. Opening an existing deck - to read
 * it, or to make a modified copy such as a template - is fine: the deck tools cannot keep another file's masters and layouts.
 */
export function createsPresentation(source: string): boolean {
  if (!/\b(?:from|import)\s+pptx\b/.test(source) || !/\.save\s*\(/.test(source) || !/\.pptx\b/i.test(source)) return false
  const opensFile = /\bPresentation\s*\(\s*[^\s)]/.test(source)
  return /\bPresentation\s*\(\s*\)/.test(source) && !opensFile
}

export const PRESENTATION_BY_SCRIPT_MESSAGE =
  'A presentation is not built with a script: use the deck tools — pptx_start_deck, then for each slide pptx_add_slide and ' +
  'delegate_to_page-creator with a brief for that slide (put any picture, already saved with download_image, in the brief by its ' +
  'resources/ path), then pptx_save_deck once. The deck tools support fonts (fontFace), slide background colours, images, ' +
  'shapes, charts and tables.'

export const pythonRunTool: Tool = {
  name: 'python_run',
  description:
    "Run Python in the workspace virtual environment (matplotlib, numpy, pillow, python-docx, openpyxl are normally installed). " +
    'Give EITHER `code` (source; saved to code/run_<time>.py) OR `script` (an existing .py path in the workspace), plus optional `args`. ' +
    'No shell is involved, so nothing to quote: put multi-line code straight in `code`. Returns the exit code, stdout, stderr and the files ' +
    'the run created or changed (found by the app). Runs in the workspace root; save charts to a file (plots never display). ' +
    "Earlier `.sachiv-handoff/` data: read it in the script (`open`/`json.load`), never retype its rows into the source. " +
    'Not a sandbox — the user approves every run.',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Python source. Use this OR `script`.' },
      script: { type: 'string', description: 'Workspace-relative .py path. Use this OR `code`.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments (sys.argv[1:]).' },
      timeoutSeconds: { type: 'number', description: `Kill after this long (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).` }
    }
  },
  mutates: true,
  cancellable: true,
  describe(input) {
    const args = Array.isArray(input.args) && input.args.length ? ` ${(input.args as unknown[]).map(String).join(' ')}` : ''
    if (typeof input.script === 'string' && input.script) return `Run Python script: ${input.script}${args}`
    const code = typeof input.code === 'string' ? input.code : ''
    const shown = code.length > DESCRIBE_PREVIEW_CHARS ? code.slice(0, DESCRIBE_PREVIEW_CHARS) + `\n… (${code.length - DESCRIBE_PREVIEW_CHARS} more characters)` : code
    return `Run Python code${args}:\n${shown}`
  },
  async execute(input, ctx, signal) {
    const hasCode = typeof input.code === 'string' && input.code.trim() !== ''
    const hasScript = typeof input.script === 'string' && input.script.trim() !== ''
    if (hasCode === hasScript) throw new Error('Give exactly one of `code` (Python source) or `script` (a .py path in the workspace).')
    const args = Array.isArray(input.args) ? input.args.map(String) : []
    const timeoutS = Math.min(Math.max(Number(input.timeoutSeconds) || DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S)

    {
      const source = hasScript ? await readFile(ctx.workspaceGuard.assertWithinWorkspace(String(input.script)), 'utf-8').catch(() => '') : String(input.code)
      if (createsPresentation(source)) throw new Error(PRESENTATION_BY_SCRIPT_MESSAGE)
    }

    const interpreter = resolveInterpreter(ctx)
    if ('error' in interpreter) throw new Error(interpreter.error)

    const root = ctx.workspaceGuard.root
    let scriptRel: string
    let generated = false
    if (hasScript) {
      const abs = ctx.workspaceGuard.assertWithinWorkspace(String(input.script))
      if (!/\.py$/i.test(abs)) throw new Error('`script` must be a .py file.')
      if (!existsSync(abs)) throw new Error(`Script not found: ${String(input.script)}`)
      scriptRel = path.relative(root, abs).split(path.sep).join('/')
    } else {
      // Kept (not a temp file) so the run is reproducible and the user can open, edit and re-run it.
      scriptRel = `code/run_${stamp()}.py`
      let abs = ctx.workspaceGuard.assertWithinWorkspace(scriptRel)
      for (let n = 2; existsSync(abs); n++) abs = ctx.workspaceGuard.assertWithinWorkspace((scriptRel = `code/run_${stamp()}_${n}.py`))
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, String(input.code), 'utf-8')
      generated = true
    }

    const { env } = withWorkspaceVenv(root, process.env)
    // Headless matplotlib: a plot must be saved to a file; plt.show() would otherwise try to open a window (or hang).
    env.MPLBACKEND ??= 'Agg'
    env.PYTHONUNBUFFERED = '1'
    env.PYTHONIOENCODING = 'utf-8'
    // Where scratch and intermediate files belong (auto-cleared); scripts can read it instead of hard-coding a path.
    const scratchDir = path.join(root, SCRATCH_DIR)
    await mkdir(scratchDir, { recursive: true })
    env.SACHIV_TMP = scratchDir

    const before = await snapshotWorkspace(root)
    const outcome = await new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>((resolvePromise, reject) => {
      execFile(
        interpreter.python,
        [scriptRel, ...args],
        { cwd: root, env, timeout: timeoutS * 1000, maxBuffer: MAX_BUFFER_BYTES, signal, windowsHide: true },
        (error, stdout, stderr) => {
          const e = error as (NodeJS.ErrnoException & { killed?: boolean }) | null
          if (e && typeof e.code !== 'number') {
            if (signal?.aborted) return reject(e) // the user pressed Stop — not a timeout
            if (e.killed) return resolvePromise({ code: -1, stdout, stderr, timedOut: true })
            if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolvePromise({ code: -1, stdout, stderr: `${stderr}\n[output exceeded ${MAX_BUFFER_BYTES / 1_000_000} MB and the run was stopped]`, timedOut: false })
            return reject(e) // could not launch the interpreter at all, or the run was aborted
          }
          resolvePromise({ code: typeof e?.code === 'number' ? e.code : 0, stdout, stderr, timedOut: false })
        }
      )
    })
    const diff = diffSnapshots(before, await snapshotWorkspace(root))
    // A bulk of loose new files in the workspace root is filed away (see tidyRootStrays); report their new locations.
    const moved = await tidyRootStrays(root, diff.created)
    if (moved.length) {
      const renamed = new Map(moved.map((m) => [m.from, m.to]))
      diff.created = diff.created.map((f) => renamed.get(f) ?? f)
    }

    const parts = [outcome.timedOut ? `exit code: none — timed out after ${timeoutS}s and was stopped` : `exit code: ${outcome.code}`]
    // Found live (2026-10-01): "re-run it with `script`", with no caveat, read naturally as "reference this
    // alongside your revised code" to a model fixing a failed run — producing exactly the `code`+`script`-
    // together call this tool rejects (line 94's "Give exactly one of..."), burning a whole round on a
    // malformed call instead of the actual fix. Spelled out explicitly: UNCHANGED, ALONE, never with `code`.
    parts.push(`script: ${scriptRel}${generated ? ' (saved from `code`; to re-run it UNCHANGED, pass `script` ALONE — never together with `code`; for a fix, pass the revised source as `code` again instead)' : ''}`)
    if (outcome.stdout.trim()) parts.push(`stdout:\n${clip(outcome.stdout)}`)
    if (outcome.stderr.trim()) parts.push(`stderr:\n${clip(outcome.stderr)}`)
    if (moved.length) {
      parts.push(
        `Moved ${moved.length} file(s) the script left in the workspace root: ${moved.slice(0, MAX_LISTED_FILES).map((m) => `${m.from} -> ${m.to}`).join(', ')}${moved.length > MAX_LISTED_FILES ? ', ...' : ''}. Use the new paths — and put scratch files in tmp/ (env SACHIV_TMP) next time.`
      )
    }
    // The generated script itself is not a result of the run.
    const produced = [...diff.created, ...diff.modified].filter((f) => !(generated && f === scriptRel))
    if (produced.length) {
      const shown = produced.slice(0, MAX_LISTED_FILES)
      parts.push(`Files created or changed by this run (found by the app): ${shown.join(', ')}${produced.length > shown.length ? `, and ${produced.length - shown.length} more` : ''}`)
    } else if (diff.reliable) {
      parts.push('Files created or changed by this run: none.' + (outcome.code === 0 ? ' If you expected output, the script did not write any — check that it saves to a file.' : ''))
    } else {
      parts.push('Files created or changed: could not be determined (the workspace is too large to scan).')
    }
    return parts.join('\n\n')
  }
}
