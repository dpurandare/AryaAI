import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// tools/setup.ts imports `electron` directly (app.getPath('documents')) and
// transitively via tools/db/index.ts -> data/connections.ts ->
// security/keychain.ts — same hazard documented in mcp/config.test.ts.
let documentsDir: string
let userDataDir: string
let homeDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'documents' ? documentsDir : name === 'home' ? homeDir : userDataDir)
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, 'utf-8'),
    decryptString: (buf: Buffer) => buf.toString('utf-8')
  }
}))

const { setDbPath } = await import('../db')
const { setSetting } = await import('../db/settings')
const { createToolContext, defaultWorkspaceRoot, WORKSPACE_ROOT_SETTING_KEY } = await import('./setup')

describe('createToolContext', () => {
  beforeEach(async () => {
    setDbPath(':memory:')
    documentsDir = await mkdtemp(join(tmpdir(), 'sachiv-setup-docs-'))
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-setup-userdata-'))
    homeDir = await mkdtemp(join(tmpdir(), 'sachiv-setup-home-'))
  })

  afterEach(async () => {
    await rm(documentsDir, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
    await rm(homeDir, { recursive: true, force: true })
  })

  it('defaults to a "Sachivji Workspace" folder under Documents when unconfigured', () => {
    const ctx = createToolContext()
    expect(ctx.workspaceGuard.root).toBe(defaultWorkspaceRoot())
    expect(existsSync(ctx.workspaceGuard.root)).toBe(true)
  })

  it('on Windows, builds the Documents default from app.getPath("home") instead of app.getPath("documents") (avoids OneDrive Known Folder Move redirection — TASKS #202)', () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      expect(defaultWorkspaceRoot()).toBe(join(homeDir, 'Documents', 'Sachivji Workspace'))
      expect(defaultWorkspaceRoot()).not.toBe(join(documentsDir, 'Sachivji Workspace'))
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('SACHIV_WORKSPACE_DIR replaces the Documents default (manual-test hook), but a configured workspace still wins', async () => {
    const override = join(documentsDir, 'override-ws')
    process.env.SACHIV_WORKSPACE_DIR = override
    try {
      expect(defaultWorkspaceRoot()).toBe(override)
      expect(createToolContext().workspaceGuard.root).toBe(override)
    } finally {
      delete process.env.SACHIV_WORKSPACE_DIR
    }
    expect(defaultWorkspaceRoot()).toBe(join(documentsDir, 'Sachivji Workspace'))
  })

  it('uses the persisted workspace root when one is configured', async () => {
    const custom = await mkdtemp(join(tmpdir(), 'sachiv-custom-workspace-'))
    setSetting(WORKSPACE_ROOT_SETTING_KEY, custom)

    const ctx = createToolContext()

    expect(ctx.workspaceGuard.root).toBe(custom)
    await rm(custom, { recursive: true, force: true })
  })

  it('creates the workspace directory if it does not exist yet', () => {
    const missing = join(documentsDir, 'not-yet-created')
    setSetting(WORKSPACE_ROOT_SETTING_KEY, missing)

    const ctx = createToolContext()

    expect(existsSync(ctx.workspaceGuard.root)).toBe(true)
  })
})
