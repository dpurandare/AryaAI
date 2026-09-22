import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  listEmailConnections,
  resolveDefaultEmailConnection,
  resolveEmailConnection
} from '../../data/email-connections'
import type { Tool } from '../types'
import { createEmailTransport } from './transport'

export const listEmailConnectionsTool: Tool = {
  name: 'list_email_connections',
  description: 'List the email accounts configured in Settings > Email accounts, by name and address (no secrets) — use this to pick which account to send from when more than one is configured.',
  inputSchema: { type: 'object', properties: {} },
  mutates: false,
  async execute() {
    const connections = listEmailConnections()
    if (!connections.length) {
      return 'No email accounts configured yet. Ask the user to add one in Settings > Email accounts.'
    }
    return connections.map((c) => `- ${c.name}: ${c.emailAddress}${c.isDefault ? ' (default)' : ''}`).join('\n')
  }
}

/** Resolves `send_email`'s optional `connection` input: the named one, or the configured default when omitted. Shared by `describe` (so the confirmation dialog shows the real sender before anything is sent) and `execute` — both need the exact same resolution, not two separately-maintained copies of this logic. */
function resolveTargetConnection(input: Record<string, unknown>) {
  const connectionName = typeof input.connection === 'string' ? input.connection.trim() : ''
  return connectionName ? resolveEmailConnection(connectionName) : resolveDefaultEmailConnection()
}

export const sendEmailTool: Tool = {
  name: 'send_email',
  description:
    'Send a real email via a configured email account (Settings > Email accounts). `connection` is ' +
    "optional — omit it to use the account marked default in Settings (or the sole configured account, " +
    'if only one exists); call list_email_connections first if more than one account is configured and ' +
    'none is marked default, or if you need to pick a specific non-default one. Recipients are email ' +
    'addresses; attachments are workspace-relative file paths. This is genuinely irreversible once sent ' +
    '— the confirmation dialog shows the sending account, recipients, subject, and attachments before ' +
    'anything is sent.',
  inputSchema: {
    type: 'object',
    properties: {
      connection: {
        type: 'string',
        description: 'Optional connection name from list_email_connections — omit to use the default account'
      },
      to: { type: 'array', items: { type: 'string' }, description: 'Recipient email address(es)' },
      subject: { type: 'string' },
      body: { type: 'string' },
      attachments: { type: 'array', items: { type: 'string' }, description: 'Optional workspace-relative file paths' }
    },
    required: ['to', 'subject', 'body']
  },
  mutates: true,
  describe(input) {
    const to = Array.isArray(input.to) ? input.to.join(', ') : String(input.to ?? '')
    const attachments = Array.isArray(input.attachments) ? input.attachments : []
    const attachmentNote = attachments.length ? ` (${attachments.length} attachment(s))` : ''
    const conn = resolveTargetConnection(input)
    const from = conn ? ` from ${conn.emailAddress}` : ''
    return `Send email${from} to ${to}: "${String(input.subject ?? '')}"${attachmentNote}`
  },
  async execute(input, ctx) {
    const conn = resolveTargetConnection(input)
    if (!conn) {
      const connectionName = typeof input.connection === 'string' ? input.connection.trim() : ''
      throw new Error(
        connectionName
          ? `Unknown email connection "${connectionName}". Call list_email_connections first.`
          : 'No email connection specified and no default account is configured. Call list_email_connections ' +
            'to see what exists, or set a default in Settings > Email accounts.'
      )
    }

    const to = Array.isArray(input.to) ? input.to.map(String) : [String(input.to ?? '')]
    if (to.length === 0 || !to[0]) throw new Error('"to" must have at least one recipient address.')

    const attachmentPaths = Array.isArray(input.attachments) ? input.attachments.map(String) : []
    const attachments = await Promise.all(
      attachmentPaths.map(async (relPath) => {
        const absPath = ctx.workspaceGuard.assertWithinWorkspace(relPath)
        return { filename: basename(absPath), content: await readFile(absPath) }
      })
    )

    const transport = createEmailTransport(conn)
    await transport.sendMail({
      from: conn.emailAddress,
      to,
      subject: String(input.subject ?? ''),
      text: String(input.body ?? ''),
      attachments
    })

    return `Sent to ${to.join(', ')}.`
  }
}
