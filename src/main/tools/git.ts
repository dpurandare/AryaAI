import { runCliCommand } from './cli-tool'
import type { Tool } from './types'

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
    '(commit, branch, checkout, merge, push, etc.) requires human confirmation first.',
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
    return runCliCommand('git', argsFrom(input), ctx.workspaceGuard.root)
  }
}
