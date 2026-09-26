/**
 * Runs a command with a provider API key taken from Sachivji's own secret store, so the key never has to be typed, exported or pasted:
 *
 *   ./node_modules/electron/dist/electron --no-sandbox scripts/with-app-key.cjs google -- \
 *       npx vite-node --config vitest.config.ts scripts/routing-eval.mts -- google gemini-3.5-flash-lite --probe-only
 *
 * The key is decrypted in memory with Electron's safeStorage (the same OS-keyring mechanism the app uses; it works only as the same OS
 * user, in the same keyring), handed to the child process as environment variables (GOOGLE_API_KEY / GEMINI_API_KEY, ANTHROPIC_API_KEY, …)
 * and REDACTED from everything the child prints. It is never written to disk and never logged. Only the credentials file is read — never the
 * database. Set SACHIV_USER_DATA to use a different profile folder (default: ~/.config/Sachivji, Linux).
 *
 * Works for both secret-storage modes (OS keychain, or the plaintext ~/.sachivji/.env file).
 */
const { app, safeStorage } = require('electron')
const { existsSync, readFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')
const { spawn } = require('node:child_process')

app.setName('Sachivji') // the keyring entry is per app name (same as src/main/index.ts)
app.disableHardwareAcceleration()

const ENV_NAMES = {
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY']
}

// Under Electron, argv is [electron, ...flags, this script, ...args]: take what follows this script.
const argv = process.argv.slice(process.argv.findIndex((a) => a.endsWith('with-app-key.cjs')) + 1)
const sep = argv.indexOf('--')
const provider = argv[0]
const command = sep >= 0 ? argv.slice(sep + 1) : []
if (!provider || !ENV_NAMES[provider] || command.length === 0) {
  console.error('usage: electron --no-sandbox scripts/with-app-key.cjs <google|anthropic|openai|groq|mistral> -- <command...>')
  app.exit(2)
}

function readKey() {
  const userData = process.env.SACHIV_USER_DATA || join(homedir(), '.config', 'Sachivji')
  const store = join(userData, 'credentials.enc.json')
  if (existsSync(store)) {
    const ciphertext = JSON.parse(readFileSync(store, 'utf-8'))[provider]
    if (ciphertext) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage is not available to this process')
      return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
    }
  }
  const envFile = join(homedir(), '.sachivji', '.env')
  if (existsSync(envFile)) {
    const line = readFileSync(envFile, 'utf-8').split('\n').find((l) => l.startsWith(`PROVIDER_${provider.toUpperCase()}=`))
    if (line) return Buffer.from(line.slice(line.indexOf('=') + 1).trim(), 'base64').toString('utf-8')
  }
  return undefined
}

app.whenReady().then(() => {
  let key
  try {
    key = readKey()
  } catch (err) {
    console.error(`Could not read the ${provider} key: ${err.message}`)
    return app.exit(1)
  }
  if (!key) {
    console.error(`No ${provider} key is stored in Sachivji's secret store.`)
    return app.exit(1)
  }
  const env = { ...process.env }
  for (const name of ENV_NAMES[provider]) env[name] = key
  // The child must not run as Electron-as-Node by accident.
  delete env.ELECTRON_RUN_AS_NODE

  const redact = (chunk) => chunk.toString().split(key).join('[redacted]')
  const child = spawn(command[0], command.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (c) => process.stdout.write(redact(c)))
  child.stderr.on('data', (c) => process.stderr.write(redact(c)))
  child.on('error', (err) => {
    console.error(`Could not start "${command[0]}": ${err.message}`)
    app.exit(1)
  })
  child.on('close', (code) => app.exit(code ?? 1))
})
