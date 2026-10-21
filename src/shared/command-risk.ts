/**
 * TASKS #234: tools that run a command or script are not limited to the workspace (`cat /etc/hostname`, `cat ~/.ssh/id_rsa`), so unlike
 * the file tools they have no path gate; the per-call confirmation is their only safeguard. This holds the pieces that protect it: which
 * tools those are, the protected places (shared with the file tools' own list), and a best-effort warning for the confirmation dialog.
 */

/** Tools that run a command or script. The session-wide auto-approve switch never covers these; only an explicit per-tool rule does. */
export const SHELL_LIKE_TOOLS: readonly string[] = ['shell_execute', 'python_run', 'git_exec', 'aws_cli', 'azure_cli', 'gcloud_cli', 'github_cli']

export function isShellLikeTool(name: string): boolean {
  return SHELL_LIKE_TOOLS.includes(name)
}

/** Home-relative places that are never offered by the file tools, even if a parent folder was granted. */
export const PROTECTED_UNDER_HOME: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.azure',
  '.kube',
  '.docker',
  '.config/gcloud',
  '.sachivji',
  'Library/Keychains',
  'Library/Cookies',
  'Library/Application Support/Sachivji',
  'Library/Application Support/Sachiv'
]
export const PROTECTED_ABSOLUTE: readonly string[] = ['/etc', '/private/etc', '/var/db', '/System', '/Library/Keychains']

export type CommandWarning = { level: 'protected' | 'outside'; text: string }

function stringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) stringValues(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringValues(v, out)
  return out
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Best-effort, string-level check of what a shell-like call mentions. Only a WARNING in the dialog: a command can build a path any number
 * of ways, so this never decides anything and is not a protection by itself. Null for other tools or when nothing stands out.
 */
export function commandWarning(toolName: string, input: Record<string, unknown>): CommandWarning | null {
  if (!isShellLikeTool(toolName)) return null
  const text = stringValues(input).join('\n').replace(/\\/g, '/').toLowerCase()
  const homeHit = PROTECTED_UNDER_HOME.find((p) => text.includes('/' + p.toLowerCase()))
  const absHit = PROTECTED_ABSOLUTE.find((p) => new RegExp(`(^|[\\s'"=;&|(])${escapeRe(p.toLowerCase())}($|[/\\s'";&|)])`).test(text))
  const hit = homeHit ?? absHit
  if (hit) {
    return {
      level: 'protected',
      text: `This command mentions ${hit.startsWith('/') ? hit : '~/' + hit}, a protected location (credentials, keys or system files). The file tools refuse it; a command does not. Approve only if you meant it.`
    }
  }
  if (/(^|[\s'"=;&|(])(~|\$home|\.\.)(\/|$|[\s'";&|)])|(^|[\s'"=;&|(])\/[a-z]|(^|[\s'"=;&|(])[a-z]:\//.test(text)) {
    return {
      level: 'outside',
      text: 'This command mentions a path that may be outside the workspace. A command is not limited to the workspace; check it before approving.'
    }
  }
  return null
}
