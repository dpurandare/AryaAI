// First-run screens: secret storage, Python, local embeddings. Needs a network connection once
// (the embedding model, about 274 MB, and the Python packages are downloaded into the throwaway profile).
const CONTINUE_ENABLED = "[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Continue' && !b.disabled)"

export async function run(s) {
  const names = ['first-run-secrets', 'first-run-python', 'first-run-embeddings']
  if (!names.some((n) => s.wanted(n))) return
  console.log('First-run screens')

  await s.launch()
  await s.waitForText('Welcome to Sachivji')
  await s.waitFor("!document.body.innerText.includes('Starting')", { label: 'the splash screen to fade' })
  await s.shot('first-run-secrets')
  await s.quit()
  if (!s.wanted('first-run-python') && !s.wanted('first-run-embeddings')) return

  // Skip the secret-storage choice (it would touch the real Keychain) and start at the Python step.
  s.sql(s.setSetting('onboardingSecretsChosen', 'true'))
  await s.launch()
  await s.waitForText('Sachivji runs agent-written scripts', { timeout: 60000 })
  await s.waitFor(CONTINUE_ENABLED, { timeout: 300000, label: 'the Python step to become ready' })
  await s.shot('first-run-python')
  await s.click('Continue')

  await s.waitForText('Local embeddings', { timeout: 60000 })
  await s.waitFor(CONTINUE_ENABLED, { timeout: 600000, label: 'the embedding model download' })
  await s.shot('first-run-embeddings')
  await s.click('Continue')
  await s.waitFor("!document.body.innerText.includes('Welcome to Sachivji')", { timeout: 30000, label: 'onboarding to close' })
  await s.quit()
}
