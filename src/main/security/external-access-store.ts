import { getSetting, setSetting } from '../db/settings'
import { EXTERNAL_READ_FOLDERS_SETTING_KEY, ExternalAccess } from './external-access'

function readFolders(): string[] {
  const raw = getSetting(EXTERNAL_READ_FOLDERS_SETTING_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : []
  } catch {
    return []
  }
}

/** The app-wide grants: "always" folders persist in settings (listed, and revocable, in Settings); session grants live in memory. */
export const externalAccess = new ExternalAccess({
  getAlways: readFolders,
  setAlways: (folders) => setSetting(EXTERNAL_READ_FOLDERS_SETTING_KEY, JSON.stringify(folders))
})
