import nodemailer, { type Transporter } from 'nodemailer'
import type { EmailProvider } from '@shared/ipc-contract'

export interface EmailTransportConfig {
  provider: EmailProvider
  emailAddress: string
  appPassword: string
  /** `custom` only. */
  host?: string
  port?: number
  secure?: boolean
}

/**
 * Gmail uses nodemailer's own `service: 'gmail'` preset (host/port/TLS
 * handled internally) — real and durable for a personal account with
 * 2-Step Verification enabled. `custom` is a plain nodemailer
 * {host, port, secure} transport for any other SMTP server (Yahoo, iCloud,
 * a company's own mail server, Zoho, ...) the user configures directly.
 *
 * Deliberately no Microsoft-specific provider here: tried one (2026-09-22)
 * and reverted after confirming live (a real SMTP login attempt, not just
 * docs) that Microsoft has fully retired SMTP Basic Auth — app passwords
 * included — for both Office 365/Microsoft 365 work accounts and personal
 * Outlook.com/Hotmail accounts, with no per-account or admin toggle to
 * bring it back. A real first-class Outlook option needs OAuth2/Microsoft
 * Graph instead — see TASKS.md #79's already-documented Phase 2 (a
 * different integration shape entirely: a direct Graph API call, not a
 * nodemailer transport at all, so it doesn't belong in this file even once
 * built).
 */
export function createEmailTransport(config: EmailTransportConfig): Transporter {
  const auth = { user: config.emailAddress, pass: config.appPassword }
  if (config.provider === 'custom') {
    return nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure, auth })
  }
  return nodemailer.createTransport({ service: 'gmail', auth })
}

/** A real login handshake with no message sent — used both by the Settings "add account" validation and, in principle, anywhere else that needs to confirm an app password actually works before relying on it. Throws nodemailer's own real error (bad password, account not found, etc.) on failure. */
export async function verifyEmailConnection(config: EmailTransportConfig): Promise<void> {
  const transport = createEmailTransport(config)
  await transport.verify()
}
