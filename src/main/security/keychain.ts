import { app, safeStorage } from 'electron'
import { parse as parseDotenv } from 'dotenv'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSetting, setSetting } from '../db/settings'

/**
 * Provider API keys (and, via the same functions, every DB/API/MCP
 * connection secret — see data/connections.ts et al.) are encrypted at
 * rest via Electron's OS-native safeStorage (Keychain on macOS, DPAPI on
 * Windows, libsecret on Linux) by default, never written to disk in
 * plaintext. #75 adds a second, opt-in backend: a plaintext `.env` file,
 * for a user who explicitly prefers that over OS-native storage (e.g. a
 * headless Linux box with no secret-service keyring running at all — see
 * the README's Prerequisites section). This module is the one place every
 * caller already goes through (`setApiKey`/`getApiKey`/`deleteApiKey`), so
 * switching backends needed zero changes anywhere else in the app.
 */
const STORE_FILE = () => join(app.getPath('userData'), 'credentials.enc.json')
const ENV_DIR = () => join(homedir(), '.sachivji')
const ENV_FILE = () => join(ENV_DIR(), '.env')
const MODE_SETTING_KEY = 'secretStorageMode'

export type SecretStorageMode = 'keychain' | 'file'

export function getSecretStorageMode(): SecretStorageMode {
  return getSetting(MODE_SETTING_KEY) === 'file' ? 'file' : 'keychain'
}

export function envFilePath(): string {
  return ENV_FILE()
}

// --- Keychain (safeStorage) backend ---

type EncryptedStore = Record<string, string> // internal key -> base64 ciphertext

function readKeychainStore(): EncryptedStore {
  const file = STORE_FILE()
  if (!existsSync(file)) return {}
  return JSON.parse(readFileSync(file, 'utf-8'))
}

function writeKeychainStore(store: EncryptedStore): void {
  writeFileSync(STORE_FILE(), JSON.stringify(store), 'utf-8')
}

function keychainSet(key: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-native secure storage is not available on this machine')
  }
  const store = readKeychainStore()
  store[key] = safeStorage.encryptString(value).toString('base64')
  writeKeychainStore(store)
}

function keychainGet(key: string): string | undefined {
  const ciphertext = readKeychainStore()[key]
  if (!ciphertext) return undefined
  return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
}

function keychainDelete(key: string): void {
  const store = readKeychainStore()
  delete store[key]
  writeKeychainStore(store)
}

// --- .env file backend ---

/**
 * Maps this app's internal secret keys (`db:<id>`, `api:<id>`, `mcp:<id>`,
 * `email:<id>`, or a bare provider/service id like `openai`/`tavily`) to
 * the .env naming convention settled for #75 — no app-name prefix, since
 * this is a dedicated file the app reads directly into its own secret
 * store, never merged into `process.env` or a shared shell session, so
 * there's no real collision risk a prefix would guard against. `email`
 * was added here when #79 introduced that key namespace — a real gap
 * found while implementing #79: this function's prefix list had been
 * written before #79 existed and needed updating, exactly the kind of
 * thing a hardcoded list like this can silently miss when a new secret
 * namespace shows up later.
 */
function envKeyFor(key: string): string {
  const match = /^(db|api|mcp|email):(.+)$/.exec(key)
  if (match) return `${match[1].toUpperCase()}_${match[2]}`
  return `PROVIDER_${key.toUpperCase()}`
}

/**
 * Values are base64-encoded, not quoted — confirmed empirically that
 * `dotenv.parse()`'s quote handling doesn't reliably round-trip a value
 * containing embedded quotes/backslashes/newlines (its double-quote
 * unescaping only substitutes `\n`/`\r`, nothing else), so this sidesteps
 * every escaping edge case entirely rather than trusting a format this
 * app doesn't fully control the parsing of. A secret is opaque data, not
 * something that needs to stay human-readable in the file.
 */
function readEnvFile(): Record<string, string> {
  const file = ENV_FILE()
  if (!existsSync(file)) return {}
  return parseDotenv(readFileSync(file, 'utf-8'))
}

function writeEnvFile(values: Record<string, string>): void {
  mkdirSync(ENV_DIR(), { recursive: true })
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`)
  const file = ENV_FILE()
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 })
  // Explicit, not just relying on the mode option at creation time — a
  // pre-existing file (or a platform where the requested mode interacts
  // with umask in a surprising way) should still end up owner-only.
  chmodSync(file, 0o600)
}

function envEncode(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64')
}

function envDecode(value: string): string {
  return Buffer.from(value, 'base64').toString('utf-8')
}

function envSet(key: string, value: string): void {
  const values = readEnvFile()
  values[envKeyFor(key)] = envEncode(value)
  writeEnvFile(values)
}

function envGet(key: string): string | undefined {
  const raw = readEnvFile()[envKeyFor(key)]
  return raw === undefined ? undefined : envDecode(raw)
}

function envDelete(key: string): void {
  const values = readEnvFile()
  delete values[envKeyFor(key)]
  writeEnvFile(values)
}

// --- Public API — every existing caller's signature is unchanged ---

export function setApiKey(key: string, value: string): void {
  if (getSecretStorageMode() === 'file') {
    envSet(key, value)
    // Dual-write (#75, revised from an original one-directional design):
    // the keychain stays a live, current backup indefinitely after
    // switching, not a frozen snapshot — see getApiKey's fallback below.
    // Best-effort: safeStorage can be genuinely unavailable on a machine
    // where that unavailability is *why* the user switched to file mode
    // in the first place (e.g. Linux with no keyring running) — a failed
    // backup write must never block the real save.
    try {
      keychainSet(key, value)
    } catch {
      /* best-effort backup only */
    }
    return
  }
  keychainSet(key, value)
}

export function getApiKey(key: string): string | undefined {
  if (getSecretStorageMode() === 'file') {
    const fromFile = envGet(key)
    if (fromFile !== undefined) return fromFile
    // .env missing, unreadable, or just doesn't have this key yet — fall
    // back to the keychain backup rather than reporting "no secret" when
    // one may still genuinely exist there.
    return keychainGet(key)
  }
  return keychainGet(key)
}

/** First 10 + last 5 characters, for Settings' "which key is this?" display — never the full key. Short keys (nothing in between to hide) come back fully masked instead. */
export function getApiKeyPreview(key: string): string | undefined {
  const value = getApiKey(key)
  if (!value) return undefined
  if (value.length <= 15) return '•'.repeat(value.length)
  return `${value.slice(0, 10)}…${value.slice(-5)}`
}

export function deleteApiKey(key: string): void {
  if (getSecretStorageMode() === 'file') {
    envDelete(key)
    try {
      keychainDelete(key)
    } catch {
      /* best-effort */
    }
    return
  }
  keychainDelete(key)
}

/**
 * One-time, one-directional action (#75) — exports everything currently
 * in the keychain into the .env file, then switches all reads/writes
 * there. There is no UI path back to `keychain` mode once this runs, but
 * the keychain itself is left untouched (not cleared) — it keeps working
 * as a dual-write backup indefinitely afterward, per the revised design.
 */
export function switchToFileStorage(): void {
  const store = readKeychainStore()
  const exported = readEnvFile()
  for (const key of Object.keys(store)) {
    const value = keychainGet(key)
    if (value !== undefined) exported[envKeyFor(key)] = envEncode(value)
  }
  writeEnvFile(exported)
  setSetting(MODE_SETTING_KEY, 'file')
}
