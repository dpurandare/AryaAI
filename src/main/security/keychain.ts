import { safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Provider API keys are encrypted at rest via Electron's OS-native
 * safeStorage (Keychain on macOS, DPAPI on Windows, libsecret on Linux) and
 * never written to disk in plaintext.
 */
const STORE_FILE = () => join(app.getPath('userData'), 'credentials.enc.json')

type EncryptedStore = Record<string, string> // providerId -> base64 ciphertext

function readStore(): EncryptedStore {
  const file = STORE_FILE()
  if (!existsSync(file)) return {}
  return JSON.parse(readFileSync(file, 'utf-8'))
}

function writeStore(store: EncryptedStore): void {
  writeFileSync(STORE_FILE(), JSON.stringify(store), 'utf-8')
}

export function setApiKey(providerId: string, apiKey: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-native secure storage is not available on this machine')
  }
  const store = readStore()
  store[providerId] = safeStorage.encryptString(apiKey).toString('base64')
  writeStore(store)
}

export function getApiKey(providerId: string): string | undefined {
  const store = readStore()
  const ciphertext = store[providerId]
  if (!ciphertext) return undefined
  return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
}

export function deleteApiKey(providerId: string): void {
  const store = readStore()
  delete store[providerId]
  writeStore(store)
}
