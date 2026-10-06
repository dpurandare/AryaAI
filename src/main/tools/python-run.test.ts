import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeState } from '@shared/runtime'
import { WorkspaceGuard } from '../security/workspace-guard'
import { PRESENTATION_BY_SCRIPT_MESSAGE, createsPresentation, pythonRunTool } from './python-run'
import type { ToolContext } from './types'

const isWindows = process.platform === 'win32'

/** A real interpreter to stand in for the workspace venv's (a symlink is enough: the tool only needs `<ws>/venv/bin/python` to exist and run). */
function findPython(): string | undefined {
  if (isWindows) return undefined
  for (const cmd of ['python3', 'python']) {
    try {
      const p = execFileSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf-8' }).trim()
      if (p) return p
    } catch {
      // try the next
    }
  }
  return undefined
}
const realPython = findPython()
const runIt = realPython ? it : it.skip

describe('python_run', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-pyrun-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 't' }
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function installVenv(): Promise<void> {
    await mkdir(join(root, 'venv', 'bin'), { recursive: true })
    await symlink(realPython!, join(root, 'venv', 'bin', 'python'))
  }

  it('is a confirmed (mutating), cancellable tool', () => {
    expect(pythonRunTool.mutates).toBe(true)
    expect(pythonRunTool.cancellable).toBe(true)
  })

  describe('what the user is shown before approving', () => {
    it('shows the actual code that will run', () => {
      expect(pythonRunTool.describe?.({ code: 'print("hi")\nprint(2)' })).toBe('Run Python code:\nprint("hi")\nprint(2)')
    })
    it('names a script and its arguments', () => {
      expect(pythonRunTool.describe?.({ script: 'code/make.py', args: ['--year', 1996] })).toBe('Run Python script: code/make.py --year 1996')
    })
    it('previews a very long program instead of flooding the dialog, and says how much was cut', () => {
      const text = pythonRunTool.describe?.({ code: 'x = 1\n'.repeat(1000) }) ?? ''
      expect(text.length).toBeLessThan(2300)
      expect(text).toMatch(/more characters\)$/)
    })
  })

  describe('input validation (no interpreter needed)', () => {
    it('needs exactly one of code / script', async () => {
      await expect(pythonRunTool.execute({}, ctx)).rejects.toThrow(/exactly one of `code`/)
      await expect(pythonRunTool.execute({ code: 'print(1)', script: 'a.py' }, ctx)).rejects.toThrow(/exactly one of `code`/)
      await expect(pythonRunTool.execute({ code: '   ' }, ctx)).rejects.toThrow(/exactly one of `code`/)
    })
  })

  describe('when there is no usable Python', () => {
    it('says so and points at Settings > Runtime, without trying to build one', async () => {
      await expect(pythonRunTool.execute({ code: 'print(1)' }, ctx)).rejects.toThrow(/no usable Python environment.*Settings > Runtime.*do not try to install Python/s)
      expect(existsSync(join(root, 'venv'))).toBe(false)
      expect(existsSync(join(root, 'code'))).toBe(false) // nothing was written either
    })

    it.each([
      ['disabled', /turned off/],
      ['creating', /still being set up/]
    ] as const)('honours the runtime state %s even when a venv exists on disk', async (status, expected) => {
      const state: RuntimeState = { status, packages: 'none', message: 'x', root }
      await expect(pythonRunTool.execute({ code: 'print(1)' }, { ...ctx, runtimeState: () => state })).rejects.toThrow(expected)
    })

    it('includes the runtime\'s own explanation when Python is missing', async () => {
      const state: RuntimeState = { status: 'missing-python', packages: 'none', message: 'Python 3.10 or newer was not found.', root }
      await expect(pythonRunTool.execute({ code: 'print(1)' }, { ...ctx, runtimeState: () => state })).rejects.toThrow(/Python 3\.10 or newer was not found/)
    })
  })

  describe('running real code (POSIX, real interpreter)', () => {
    runIt('runs source given as `code` with no shell quoting — including the multi-line, compound-statement code that broke the shell in D2', async () => {
      await installVenv()
      const code = [
        'import json',
        'data = {"2020": [{"A": 1}]}',
        'with open("data.json", "w") as f: json.dump(data, f)',
        'for year, rows in data.items():',
        '    print(year, len(rows))'
      ].join('\n')
      const out = await pythonRunTool.execute({ code }, ctx)
      expect(out).toContain('exit code: 0')
      expect(out).toContain('stdout:\n2020 1')
      expect(await readFile(join(root, 'data.json'), 'utf-8')).toBe('{"2020": [{"A": 1}]}')
    })

    runIt('saves generated code under code/ and reports the script path so it can be re-run — and does not list that script as a produced file', async () => {
      await installVenv()
      const out = await pythonRunTool.execute({ code: 'open("out.txt","w").write("x")' }, ctx)
      const scripts = await readdir(join(root, 'code'))
      expect(scripts).toHaveLength(1)
      expect(scripts[0]).toMatch(/^run_\d{8}-\d{6}\.py$/)
      expect(out).toContain(`script: code/${scripts[0]} (saved from \`code\`; to re-run it UNCHANGED, pass \`script\` ALONE — never together with \`code\`; for a fix, pass the revised source as \`code\` again instead)`)
      expect(out).toContain('Files created or changed by this run (found by the app): out.txt')
      expect(out).not.toMatch(/found by the app\): .*run_/)
    })

    runIt('runs an existing script by path, with arguments, in the workspace root', async () => {
      await installVenv()
      await mkdir(join(root, 'code'))
      await writeFile(join(root, 'code', 'args.py'), 'import sys, os\nprint(sys.argv[1:], os.path.basename(os.getcwd()))')
      const out = await pythonRunTool.execute({ script: 'code/args.py', args: ['a', 'b c'] }, ctx)
      expect(out).toContain("['a', 'b c']")
      expect(out).toContain(root.split('/').pop()!)
      expect(out).toContain('script: code/args.py\n') // not marked as generated
    })

    runIt('lists exactly the files a script created or changed, found by the app — and says "none" when it wrote nothing', async () => {
      await installVenv()
      await writeFile(join(root, 'keep.txt'), 'old')
      const out = await pythonRunTool.execute({ code: 'open("a.png","w").write("1")\nopen("keep.txt","w").write("new contents")' }, ctx)
      expect(out).toContain('Files created or changed by this run (found by the app): a.png, keep.txt')

      const none = await pythonRunTool.execute({ code: 'print("only printed")' }, ctx)
      expect(none).toMatch(/Files created or changed by this run: none\. If you expected output/)
    })

    runIt('files a bulk of loose root-level outputs away (images to resources/, the rest to tmp/) and reports the new paths — but leaves one or two requested outputs where the script wrote them', async () => {
      await installVenv()
      const few = await pythonRunTool.execute({ code: 'open("answer.json","w").write("{}")\nopen("note.txt","w").write("x")' }, ctx)
      expect(few).toContain('Files created or changed by this run (found by the app): answer.json, note.txt')
      expect(few).not.toContain('Moved')
      expect(existsSync(join(root, 'answer.json'))).toBe(true)

      const code = 'import os\nfor i in range(5):\n    open(f"page_{i}.png","w").write("x")\nopen("scratch.csv","w").write("a")\nprint(os.environ["SACHIV_TMP"])'
      const bulk = await pythonRunTool.execute({ code }, ctx)
      expect(bulk).toMatch(/Moved 6 file\(s\) the script left in the workspace root: page_0\.png -> resources\/page_0\.png/)
      expect(bulk).toContain('scratch.csv -> tmp/scratch.csv')
      expect(bulk).toContain(join(root, 'tmp')) // SACHIV_TMP points at the scratch folder
      expect(existsSync(join(root, 'page_0.png'))).toBe(false)
      expect(existsSync(join(root, 'resources', 'page_4.png'))).toBe(true)
      expect(existsSync(join(root, 'tmp', 'scratch.csv'))).toBe(true)
    })

    runIt('reports a failing script with its exit code and traceback (not as a tool error), so the model can fix it', async () => {
      await installVenv()
      const out = await pythonRunTool.execute({ code: 'import json\nprint(undefined_name)' }, ctx)
      expect(out).toContain('exit code: 1')
      expect(out).toMatch(/stderr:\n[\s\S]*NameError: name 'undefined_name' is not defined/)
      expect(out).not.toMatch(/If you expected output/) // no misleading hint after a failure
    })

    runIt('headless matplotlib backend is set, so a script that calls plt.show() cannot hang on a window', async () => {
      await installVenv()
      const out = await pythonRunTool.execute({ code: 'import os\nprint(os.environ["MPLBACKEND"])' }, ctx)
      expect(out).toContain('stdout:\nAgg')
    })

    runIt('the venv is activated for the child (VIRTUAL_ENV set, its bin first on PATH)', async () => {
      await installVenv()
      const out = await pythonRunTool.execute({ code: 'import os\nprint(os.environ["VIRTUAL_ENV"])\nprint(os.environ["PATH"].split(os.pathsep)[0])' }, ctx)
      expect(out).toContain(join(root, 'venv'))
      expect(out).toContain(join(root, 'venv', 'bin'))
    })

    runIt('stops a run that exceeds the timeout and says so', async () => {
      await installVenv()
      const out = await pythonRunTool.execute({ code: 'import time\ntime.sleep(30)', timeoutSeconds: 1 }, ctx)
      expect(out).toMatch(/exit code: none — timed out after 1s and was stopped/)
    })

    runIt('a user Stop rejects (it is not reported as a timeout)', async () => {
      await installVenv()
      const controller = new AbortController()
      const pending = pythonRunTool.execute({ code: 'import time\ntime.sleep(30)' }, ctx, controller.signal)
      setTimeout(() => controller.abort(), 300)
      await expect(pending).rejects.toThrow()
    })

    runIt('keeps only the tail of very long output (the traceback is at the end)', async () => {
      await installVenv()
      const out = await pythonRunTool.execute({ code: 'print("x" * 50000)\nprint("THE-END")' }, ctx)
      expect(out).toMatch(/earlier characters omitted/)
      expect(out).toContain('THE-END')
    })
  })

  describe('script path safety', () => {
    runIt('refuses a path outside the workspace, a non-.py file, and a missing file', async () => {
      await installVenv()
      await expect(pythonRunTool.execute({ script: '../evil.py' }, ctx)).rejects.toThrow()
      await writeFile(join(root, 'notes.txt'), 'x')
      await expect(pythonRunTool.execute({ script: 'notes.txt' }, ctx)).rejects.toThrow(/must be a \.py file/)
      await expect(pythonRunTool.execute({ script: 'nope.py' }, ctx)).rejects.toThrow(/Script not found/)
    })
  })

  describe('presentations are not built by script (found live: python-pptx instead of the deck tools)', () => {
    it('recognises code that creates a .pptx with python-pptx, and leaves other code alone — including code that only reads one', () => {
      const create = 'from pptx import Presentation\nprs = Presentation()\nprs.save("documents/deck.pptx")'
      expect(createsPresentation(create)).toBe(true)
      expect(createsPresentation('import pptx\np = pptx.Presentation()\np.save(path + ".pptx")')).toBe(true)
      expect(createsPresentation('from pptx import Presentation\nfor s in Presentation("a.pptx").slides: print(s)')).toBe(false)
      expect(createsPresentation('import docx\ndoc.save("documents/report.docx")')).toBe(false)
      expect(createsPresentation('print("a deck.pptx is a file")')).toBe(false)
    })

    it('refuses to run such code and points at the deck tools, before running anything', async () => {
      const code = 'from pptx import Presentation\nPresentation().save("documents/deck.pptx")'
      await expect(pythonRunTool.execute({ code }, ctx)).rejects.toThrow(PRESENTATION_BY_SCRIPT_MESSAGE)
      expect(PRESENTATION_BY_SCRIPT_MESSAGE).toMatch(/pptx_start_deck.*delegate_to_page-creator.*pptx_save_deck/)
    })
  })
})
