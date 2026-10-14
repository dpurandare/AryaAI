import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir: string
let testHomeDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, 'utf-8'),
    decryptString: (buf: Buffer) => buf.toString('utf-8')
  }
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => testHomeDir }
})

const { setDbPath } = await import('../db')
const { setApiKey, getApiKey, deleteApiKey, getSecretStorageMode, switchToFileStorage, envFilePath } = await import(
  './keychain'
)

describe('keychain (#75 dual-backend secret storage)', () => {
  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-keychain-userdata-'))
    testHomeDir = await mkdtemp(join(tmpdir(), 'sachiv-keychain-home-'))
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
    await rm(testHomeDir, { recursive: true, force: true })
  })

  it('defaults to keychain mode', () => {
    expect(getSecretStorageMode()).toBe('keychain')
  })

  it('keychain mode: set/get/delete a provider key and a namespaced connection secret', () => {
    setApiKey('openai', 'sk-abc')
    setApiKey('db:conn-1', 'db-password')
    expect(getApiKey('openai')).toBe('sk-abc')
    expect(getApiKey('db:conn-1')).toBe('db-password')

    deleteApiKey('openai')
    expect(getApiKey('openai')).toBeUndefined()
    expect(getApiKey('db:conn-1')).toBe('db-password')
  })

  it('switchToFileStorage exports existing keychain secrets, switches mode, and writes 0600', async () => {
    setApiKey('openai', 'sk-abc')
    setApiKey('db:conn-1', 'db-password')
    // #79's key namespace — added after #75 first shipped; regression
    // coverage for a real gap where envKeyFor's prefix list hadn't been
    // updated yet and this would have silently fallen through to
    // PROVIDER_EMAIL:conn-2 (an invalid, colon-containing env key name).
    setApiKey('email:conn-2', 'app-password')

    switchToFileStorage()

    expect(getSecretStorageMode()).toBe('file')
    expect(getApiKey('openai')).toBe('sk-abc')
    expect(getApiKey('db:conn-1')).toBe('db-password')
    expect(getApiKey('email:conn-2')).toBe('app-password')

    const info = await stat(envFilePath())
    // Windows doesn't enforce POSIX permission bits (stat reports 0o666).
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600)

    const raw = await readFile(envFilePath(), 'utf-8')
    expect(raw).toContain('PROVIDER_OPENAI=')
    expect(raw).toContain('DB_conn-1=')
    expect(raw).toContain('EMAIL_conn-2=')
    // Real secret values must never appear in plaintext in the file itself.
    expect(raw).not.toContain('sk-abc')
    expect(raw).not.toContain('db-password')
    expect(raw).not.toContain('app-password')
  })

  it('after switching, new writes go to both .env (primary) and the keychain (live backup)', async () => {
    switchToFileStorage()
    setApiKey('anthropic', 'sk-ant-new')

    expect(getApiKey('anthropic')).toBe('sk-ant-new')

    // Simulate the .env file vanishing (accidental delete, disk issue) —
    // the value must still be recoverable from the keychain backup,
    // proving the dual-write actually happened, not just the primary path.
    await rm(envFilePath(), { force: true })
    expect(getApiKey('anthropic')).toBe('sk-ant-new')
  })

  it('treats a genuinely fresh state (nothing in either backend) as no secret, not an error', () => {
    switchToFileStorage()
    expect(getApiKey('never-set')).toBeUndefined()
  })

  it('deleting a key in file mode removes it from both backends, not just the file', async () => {
    setApiKey('openai', 'sk-abc')
    switchToFileStorage()
    deleteApiKey('openai')
    expect(getApiKey('openai')).toBeUndefined()
    // Confirm it's really gone from the keychain too, not just the file —
    // otherwise a later .env loss would resurrect a "deleted" secret via
    // the fallback path.
    await rm(envFilePath(), { force: true })
    expect(getApiKey('openai')).toBeUndefined()
  })
})
