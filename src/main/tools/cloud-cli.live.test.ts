import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import type { ToolContext } from './types'
import { awsCliTool, azureCliTool, gcloudCliTool } from './cloud-cli'

/**
 * TASKS #221: optional live smoke test against the real CLIs. Skipped unless SACHIV_LIVE_CLOUD_CLI=1 AND the CLI is
 * installed; a CLI that is installed but not logged in fails its test on purpose (that is what the opt-in is for).
 * READ-ONLY commands only. Never add a command that creates, changes or deletes anything.
 *
 *   SACHIV_LIVE_CLOUD_CLI=1 npx vitest run src/main/tools/cloud-cli.live.test.ts
 */
const optedIn = process.env.SACHIV_LIVE_CLOUD_CLI === '1'
const installed = (binary: string): boolean => spawnSync(binary, ['--version'], { shell: process.platform === 'win32' }).error === undefined

const ctx: ToolContext = { workspaceGuard: new WorkspaceGuard(resolve(tmpdir(), 'sachiv-cloud-cli-live')), currentSessionId: 'live' }

const live = [
  { binary: 'aws', tool: awsCliTool, args: ['sts', 'get-caller-identity', '--output', 'json'] },
  { binary: 'az', tool: azureCliTool, args: ['account', 'show', '--output', 'json'] },
  { binary: 'gcloud', tool: gcloudCliTool, args: ['config', 'list', '--format=json'] }
]

describe('cloud CLI tools, live (opt-in, read-only)', () => {
  for (const { binary, tool, args } of live) {
    it.skipIf(!optedIn || !installed(binary))(`${binary} ${args.slice(0, 2).join(' ')} exits 0 with JSON on stdout`, async () => {
      const result = await tool.execute({ args }, ctx)
      expect(result.startsWith('exit code: 0')).toBe(true)
      expect(() => JSON.parse(result.split('stdout:\n')[1].split('\n\nstderr:')[0])).not.toThrow()
    })
  }
})
