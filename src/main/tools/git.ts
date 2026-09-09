import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { runCliCommand } from './cli-tool'
import type { Tool } from './types'

/** Every clone lives under this, so it's obvious at a glance what's a real workspace file vs. a scratch clone the user (or a "clean up" pass) can safely delete wholesale. */
const CLONES_DIR = '.sachiv-clones'

/**
 * Subcommands that only ever read repo state, never write it. Everything
 * else defaults to mutating (the safe direction) — several git subcommands
 * (branch, remote, tag, config, fetch) are read-only with no extra args but
 * become writes with one, and reasoning about flags to tell them apart risks
 * the same kind of bypass already found once in the SQL mutates-classifier
 * (src/main/tools/db/sql-classifier.ts) — so they're excluded rather than
 * guessed at.
 */
const READ_ONLY_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'describe',
  'shortlog',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'cat-file'
])

function argsFrom(input: Record<string, unknown>): string[] {
  return Array.isArray(input.args) ? (input.args as unknown[]).map(String) : []
}

export const gitExecTool: Tool = {
  name: 'git_exec',
  description:
    'Run a git command via "git" against the workspace\'s own repository. Read-only inspection ' +
    `(${[...READ_ONLY_SUBCOMMANDS].join(', ')}) runs without confirmation; everything else ` +
    '(commit, branch, checkout, merge, push, etc.) requires human confirmation first. Does NOT ' +
    'support "clone" — use git_clone_repo instead, to inspect or analyze a *different* repository ' +
    "(this tool is only for the workspace's own repo).",
  inputSchema: {
    type: 'object',
    properties: {
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Arguments to pass to git, e.g. ["log", "--oneline", "-5"]'
      }
    },
    required: ['args']
  },
  mutates: (input) => !READ_ONLY_SUBCOMMANDS.has(argsFrom(input)[0] ?? ''),
  describe(input) {
    return `Run: git ${argsFrom(input).join(' ')}`
  },
  async execute(input, ctx) {
    const args = argsFrom(input)
    if (args[0] === 'clone') {
      throw new Error(
        'git_exec does not support "clone" — use the git_clone_repo tool instead, which clones into ' +
          'its own fresh, isolated folder automatically (git_exec has no way to guarantee that, since ' +
          "it just runs whatever destination path it's given, and two clones landing in the same " +
          'folder would collide).'
      )
    }
    return runCliCommand('git', args, ctx.workspaceGuard.root)
  }
}

/** Filesystem-safe, human-readable stub from a repo URL — purely cosmetic (the actual uniqueness guarantee is the random suffix appended in execute() below), so this can be as loose as it wants. */
function slugFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '')
  const last = cleaned.split(/[\\/]/).pop() || 'repo'
  return last.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60) || 'repo'
}

export const gitCloneRepoTool: Tool = {
  name: 'git_clone_repo',
  description:
    'Clone a git repository (for inspecting/analyzing code that is NOT the workspace\'s own repo — ' +
    'use git_exec for that) into a fresh, isolated folder inside the workspace. Every call gets its ' +
    'own folder — there is no destination-path input, specifically so that concurrent or repeated ' +
    'clones (including of the same URL, including from a different chat session) can never collide. ' +
    'Returns the workspace-relative path to read from afterward with read_file/list_directory.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Repository URL to clone (https or git/ssh)' },
      ref: { type: 'string', description: 'Branch or tag to check out (default: the repo\'s default branch)' }
    },
    required: ['url']
  },
  mutates: true,
  describe(input) {
    return `Clone ${String(input.url ?? '')} into a new isolated folder for analysis`
  },
  async execute(input, ctx) {
    const url = String(input.url ?? '').trim()
    if (!url) throw new Error('No repository URL given.')
    const ref = input.ref ? String(input.ref) : undefined

    // The random suffix, not the slug, is what actually guarantees no two
    // clones ever land in the same folder — the slug is only there to keep
    // directory names readable in the sidebar/Finder.
    const relativeDest = `${CLONES_DIR}/${slugFromUrl(url)}-${randomUUID().slice(0, 8)}`
    const absoluteDest = ctx.workspaceGuard.assertWithinWorkspace(relativeDest)
    mkdirSync(dirname(absoluteDest), { recursive: true })

    const args = ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), url, absoluteDest]
    const result = await runCliCommand('git', args, ctx.workspaceGuard.root)
    return (
      `${result}\n\nCloned into "${relativeDest}" — a folder unique to this clone, not shared with ` +
      `any other clone. Read its files with read_file/list_directory using paths under that, e.g. ` +
      `read_file({ path: "${relativeDest}/README.md" }).`
    )
  }
}
