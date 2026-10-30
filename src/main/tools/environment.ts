import { existsSync } from 'node:fs'
import { arch, homedir, release } from 'node:os'
import { posix, win32 } from 'node:path'
import type { RuntimeState } from '@shared/runtime'
import type { Tool, ToolContext } from './types'

/** The facts about this machine and the workspace that agents kept guessing or searching for (found live: a lookup in the MCP wiki for "the workspace location"). */
const OS_NAMES: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

export interface EnvironmentInput {
  appVersion?: string
  platform?: NodeJS.Platform
  osRelease?: string
  architecture?: string
  home?: string
  /** Whether a home sub-folder exists (the tests pass a fake). */
  exists?: (path: string) => boolean
  now?: Date
  timeZone?: string
  workspaceRoot: string
  runtime?: RuntimeState | null
  /** Whether a workspace sub-folder exists right now (tests pass a fake); defaults to the disk. */
  workspaceExists?: (relativeFolder: string) => boolean
  /** Folders outside the workspace the user allowed for good (Settings > Workspace). */
  allowedFolders?: string[]
}

export function buildEnvironment(input: EnvironmentInput): string {
  const platform = input.platform ?? process.platform
  const home = input.home ?? homedir()
  const exists = input.exists ?? existsSync
  const now = input.now ?? new Date()
  const out: string[] = ['# This machine and the workspace']

  out.push(`App: Sachivji${input.appVersion ? ` ${input.appVersion}` : ''}`)
  out.push(`OS: ${OS_NAMES[platform] ?? platform} ${input.osRelease ?? release()} (${input.architecture ?? arch()})`)
  out.push(`Shell: ${platform === 'win32' ? 'PowerShell' : 'bash'} (shell_execute runs it with the workspace as the working directory)`)
  const timeZone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  out.push(`Now: ${now.toLocaleString('en-GB', { timeZone, dateStyle: 'full', timeStyle: 'short' })} (${timeZone})`)

  out.push(`Home folder: ${home}`)
  // Joined against `platform` (which the tests deliberately simulate as any OS, not necessarily
  // this process's own), not the default `node:path` import — that one is always host-native, so
  // a simulated-mac `home` run on an actual Windows CI runner would otherwise come back with
  // backslashes, confirmed live (TASKS: Windows CI first run after the design_change -> main merge).
  const join = platform === 'win32' ? win32.join : posix.join
  const known = ['Desktop', 'Documents', 'Downloads'].map((n) => join(home, n)).filter((p) => exists(p))
  if (known.length) out.push(`Common folders: ${known.join(', ')}`)

  const root = input.workspaceRoot
  out.push(`\nWorkspace: ${root}`)
  out.push(
    'Everything the user asks you to create or save goes in the workspace, not in the folder of a file you were just reading. ' +
      'Relative paths resolve against it, and the shell and Python run inside it, so prefer relative paths.'
  )
  // TASKS #238: say which of the conventional folders exist now, so a model does not report one that was never created (a phantom templates/).
  const present = input.workspaceExists ?? ((rel: string) => exists(join(root, rel)))
  const folder = (name: string, purpose: string): string => `- ${name}/ : ${purpose}${present(name) ? '' : ' (not created yet)'}`
  out.push(folder('code', 'scripts and source you write'))
  out.push(folder('documents', 'Word, Excel, PowerPoint and PDF files you produce, and notes (.md, .txt)'))
  out.push(folder('resources', 'pictures, charts and other media'))
  out.push(folder('data', 'data files you produce (.csv, .json)'))
  out.push(folder('downloads', 'files you download for the user'))
  out.push(folder('exports', 'files exported for the user (the Export Settings dialog opens here)'))
  out.push(folder('tmp', 'scratch files (the SACHIV_TMP environment variable in scripts), cleaned up after a few days'))
  out.push(folder('templates', "the user's own templates, read as input"))
  out.push('To show what is in the workspace, call list_directory with depth 2 or 3 (one call, folders and files).')
  out.push('A new file of a known type is filed in the matching folder even when only a bare name is given.')
  out.push("A full path in the user's message (for example a file dropped on the message box) is the file to use: read it with the file tools (outside the workspace the user is asked once per folder). Copy it into tmp/ with the shell only when a script has to run on it.")
  out.push('In scripts and shell commands a bare file name lands in the workspace root: save charts and images to resources/, documents and notes to documents/, .csv/.json data to data/, downloads to downloads/, exports to exports/, scratch to tmp/, and never leave generated files loose in the root.')

  out.push('\nOutside the workspace: reading a file in another folder needs the user\'s permission, asked per folder; creating a new file there asks every time; credentials and system folders are never reachable.')
  if (input.allowedFolders?.length) out.push(`Folders the user allowed for good: ${input.allowedFolders.join(', ')}`)

  const r = input.runtime
  out.push(
    '\n' +
      (!r
        ? 'Python: status not reported.'
        : r.status === 'ready'
          ? `Python: available${r.pythonVersion ? ` ${r.pythonVersion}` : ''}, in the workspace's venv/.`
          : `Python: ${r.status} — ${r.message}`)
  )
  return out.join('\n')
}

export function createEnvironmentTool(deps: { appVersion?: () => string | undefined } = {}): Tool {
  return {
    name: 'get_environment',
    description: 'Workspace path and its folders, OS, shell, home/Desktop/Downloads, today\'s date, Python status. Use it instead of guessing or searching.',
    inputSchema: { type: 'object', properties: {} },
    mutates: false,
    async execute(_input, ctx: ToolContext) {
      return buildEnvironment({
        appVersion: deps.appVersion?.(),
        workspaceRoot: ctx.workspaceGuard.root,
        runtime: ctx.runtimeState?.(),
        allowedFolders: ctx.externalAccess?.listAlways()
      })
    }
  }
}
