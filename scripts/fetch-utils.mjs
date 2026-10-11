// Shared by the Windows sponsor-build fetch scripts (TASKS #202): downloading a release asset
// and verifying it against a pinned sha256 before it's trusted and extracted. Deliberately plain
// `node` with no project imports, same reasoning as the scripts that use it — runs on any host OS
// with no TS build / path aliases needed.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

export async function download(url, destFile) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  await pipeline(res.body, createWriteStream(destFile))
}

export async function sha256OfFile(file) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}
