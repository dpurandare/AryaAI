/**
 * TASKS #243: tell "the provider refused the API key" (expired, revoked, wrong) apart from "the provider could not be reached" or "no models".
 * The SDKs put the HTTP status and the provider's own wording in the error text (the renderer sees it wrapped by Electron's IPC), so this works on
 * the text: 401/403 as a status, or the phrases the providers use for a bad key. Deliberately narrow: a rate limit (429), a missing model (404), a
 * server error (5xx) and a network failure are NOT key problems.
 */
const STATUS = /(^|[\s:'"(])(401|403)([\s:,'")]|$)/
const PHRASES =
  /authentication[_ ]error|unauthori[sz]ed|permission[_ ]denied|invalid[ _-]*(x-)?api[ _-]*key|incorrect api key|api[ _-]*key[ _-]*(expired|not valid|invalid|has expired)|api_key_invalid|key (has )?expired|invalid credentials/i

export function isKeyRejectedMessage(message: string | undefined | null): boolean {
  if (!message) return false
  return STATUS.test(message) || PHRASES.test(message)
}

/** One plain line for the model picker, the key section and the model lists. The key itself is never shown. */
export function keyRejectedNotice(providerName: string): string {
  return `${providerName} rejected this API key. It may have expired, been revoked or be wrong. Enter a new key to continue.`
}
