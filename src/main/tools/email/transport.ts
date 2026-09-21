import nodemailer, { type Transporter } from 'nodemailer'

/**
 * Gmail's app-password path is the only one #79 phase 1 builds — real and
 * durable today for a personal Gmail account with 2-Step Verification
 * enabled (see TASKS.md #79). `service: 'gmail'` is nodemailer's own
 * built-in preset (host/port/TLS all handled internally), so this needs
 * nothing beyond the address + app password.
 */
export function createGmailTransport(emailAddress: string, appPassword: string): Transporter {
  return nodemailer.createTransport({ service: 'gmail', auth: { user: emailAddress, pass: appPassword } })
}

/** A real login handshake with no message sent — used both by the Settings "add account" validation and, in principle, anywhere else that needs to confirm a Gmail app password actually works before relying on it. Throws nodemailer's own real error (bad password, account not found, etc.) on failure. */
export async function verifyGmailConnection(emailAddress: string, appPassword: string): Promise<void> {
  const transport = createGmailTransport(emailAddress, appPassword)
  await transport.verify()
}
