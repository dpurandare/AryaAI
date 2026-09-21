import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { listEmailConnections, resolveEmailConnection } from '../../data/email-connections'
import type { Tool } from '../types'
import { createGmailTransport } from './transport'

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
    return connections.map((c) => `- ${c.name}: ${c.emailAddress}`).join('\n')
  }
}

export const sendEmailTool: Tool = {
  name: 'send_email',
  description:
    'Send a real email via a configured email account (Settings > Email accounts — call ' +
    'list_email_connections first if you do not already know which one to use). Recipients are email ' +
    'addresses; attachments are workspace-relative file paths. This is genuinely irreversible once sent ' +
    '— the confirmation dialog shows the recipients/subject/attachments before anything is sent.',
  inputSchema: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: 'Connection name from list_email_connections' },
      to: { type: 'array', items: { type: 'string' }, description: 'Recipient email address(es)' },
      subject: { type: 'string' },
      body: { type: 'string' },
      attachments: { type: 'array', items: { type: 'string' }, description: 'Optional workspace-relative file paths' }
    },
    required: ['connection', 'to', 'subject', 'body']
  },
  mutates: true,
  describe(input) {
    const to = Array.isArray(input.to) ? input.to.join(', ') : String(input.to ?? '')
    const attachments = Array.isArray(input.attachments) ? input.attachments : []
    const attachmentNote = attachments.length ? ` (${attachments.length} attachment(s))` : ''
    return `Send email to ${to}: "${String(input.subject ?? '')}"${attachmentNote}`
  },
  async execute(input, ctx) {
    const connectionName = String(input.connection ?? '')
    const conn = resolveEmailConnection(connectionName)
    if (!conn) {
      throw new Error(`Unknown email connection "${connectionName}". Call list_email_connections first.`)
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

    const transport = createGmailTransport(conn.emailAddress, conn.appPassword)
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
