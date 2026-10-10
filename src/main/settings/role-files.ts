import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * The user-defined role files (one `.md` each) for settings export/import. Files starting with `_` never load as roles (the example
 * file), so they are not exported either. Sync `node:fs` on purpose: a role folder is a handful of small files.
 */
const MAX_ROLE_FILE_BYTES = 100_000

export function isRoleFileName(name: string): boolean {
  return name.endsWith('.md') && !name.startsWith('_') && !name.startsWith('.')
}

export function readRoleFiles(folder: string): Array<{ fileName: string; content: string }> {
  if (!existsSync(folder)) return []
  const out: Array<{ fileName: string; content: string }> = []
  for (const fileName of readdirSync(folder).filter(isRoleFileName).sort()) {
    try {
      const content = readFileSync(join(folder, fileName), 'utf-8')
      if (content.length <= MAX_ROLE_FILE_BYTES) out.push({ fileName, content })
    } catch {
      // an unreadable file is left out of the export rather than stopping it
    }
  }
  return out
}

/** Only a plain file name is ever used: any directory part in an imported name is dropped, so an import can never write outside the roles folder. */
export function safeRoleFileName(name: string): string | undefined {
  const base = basename(String(name).replace(/\\/g, '/'))
  return isRoleFileName(base) ? base : undefined
}

export function roleFileExists(folder: string, fileName: string): boolean {
  return existsSync(join(folder, fileName))
}

/** Writes a role file only if there is none of that name; returns whether it wrote. */
export function writeRoleFile(folder: string, fileName: string, content: string): boolean {
  if (content.length > MAX_ROLE_FILE_BYTES || roleFileExists(folder, fileName)) return false
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, fileName), content, { encoding: 'utf-8', flag: 'wx' })
  return true
}
