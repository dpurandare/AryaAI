import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import type { ToolContext } from '../types'

let userDataDir: string
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, 'utf-8'),
    decryptString: (buf: Buffer) => buf.toString('utf-8')
  }
}))

const mockSendMail = vi.fn()
const mockVerify = vi.fn()
const mockCreateTransport = vi.fn().mockImplementation(() => ({ sendMail: mockSendMail, verify: mockVerify }))
vi.mock('nodemailer', () => ({ default: { createTransport: mockCreateTransport } }))

const { setDbPath } = await import('../../db')
const { saveEmailConnection, setDefaultEmailConnection } = await import('../../data/email-connections')
const { sendEmailTool, listEmailConnectionsTool } = await import('./index')
const { verifyEmailConnection } = await import('./transport')

describe('email tools (#79)', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-email-tools-'))
    root = await mkdtemp(join(tmpdir(), 'sachiv-email-tools-ws-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
    mockSendMail.mockReset().mockResolvedValue({ messageId: 'abc' })
    mockVerify.mockReset().mockResolvedValue(true)
    mockCreateTransport.mockClear()
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })

  it('list_email_connections reports plainly when none are configured', async () => {
    expect(await listEmailConnectionsTool.execute({}, ctx)).toMatch(/No email accounts configured/)
  })

  it('list_email_connections lists configured accounts by name and address, no secrets', async () => {
    saveEmailConnection({ name: 'Work Gmail', provider: 'gmail', emailAddress: 'me@gmail.com', appPassword: 'pw' })
    const result = await listEmailConnectionsTool.execute({}, ctx)
    expect(result).toContain('Work Gmail')
    expect(result).toContain('me@gmail.com')
    expect(result).not.toContain('pw')
  })

  it('send_email always mutates and describes recipients/subject', () => {
    expect(sendEmailTool.mutates).toBe(true)
    expect(sendEmailTool.describe?.({ to: ['a@x.com', 'b@x.com'], subject: 'Hi' })).toBe(
      'Send email to a@x.com, b@x.com: "Hi"'
    )
  })

  it('sends a real-shaped email via the resolved connection, with the real app password never leaving this module', async () => {
    saveEmailConnection({ name: 'Work Gmail', provider: 'gmail', emailAddress: 'me@gmail.com', appPassword: 'shh' })

    const result = await sendEmailTool.execute(
      { connection: 'Work Gmail', to: ['friend@example.com'], subject: 'Hello', body: 'Hi there' },
      ctx
    )

    expect(result).toBe('Sent to friend@example.com.')
    expect(mockCreateTransport).toHaveBeenCalledWith({ service: 'gmail', auth: { user: 'me@gmail.com', pass: 'shh' } })
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'me@gmail.com', to: ['friend@example.com'], subject: 'Hello', text: 'Hi there' })
    )
  })

  it('sends via a custom SMTP connection using its own host/port/secure, not a nodemailer service preset', async () => {
    saveEmailConnection({
      name: 'Company mail',
      provider: 'custom',
      emailAddress: 'me@company.com',
      appPassword: 'shh',
      host: 'smtp.company.com',
      port: 465,
      secure: true
    })

    const result = await sendEmailTool.execute(
      { connection: 'Company mail', to: ['friend@example.com'], subject: 'Hello', body: 'Hi there' },
      ctx
    )

    expect(result).toBe('Sent to friend@example.com.')
    expect(mockCreateTransport).toHaveBeenCalledWith({
      host: 'smtp.company.com',
      port: 465,
      secure: true,
      auth: { user: 'me@company.com', pass: 'shh' }
    })
  })

  it('resolves a real workspace attachment into filename + content', async () => {
    saveEmailConnection({ name: 'Work Gmail', provider: 'gmail', emailAddress: 'me@gmail.com', appPassword: 'shh' })
    await writeFile(join(root, 'report.txt'), 'real content', 'utf-8')

    await sendEmailTool.execute(
      { connection: 'Work Gmail', to: ['friend@example.com'], subject: 'Hi', body: 'x', attachments: ['report.txt'] },
      ctx
    )

    const call = mockSendMail.mock.calls[0][0]
    expect(call.attachments).toHaveLength(1)
    expect(call.attachments[0].filename).toBe('report.txt')
    expect(call.attachments[0].content.toString('utf-8')).toBe('real content')
  })

  it('respects the workspace boundary for attachments', async () => {
    saveEmailConnection({ name: 'Work Gmail', provider: 'gmail', emailAddress: 'me@gmail.com', appPassword: 'shh' })
    await expect(
      sendEmailTool.execute(
        { connection: 'Work Gmail', to: ['x@x.com'], subject: 's', body: 'b', attachments: ['../escape.txt'] },
        ctx
      )
    ).rejects.toThrow(/workspace boundary/)
  })

  it('rejects an unknown connection without ever calling nodemailer', async () => {
    await expect(
      sendEmailTool.execute({ connection: 'nope', to: ['x@x.com'], subject: 's', body: 'b' }, ctx)
    ).rejects.toThrow(/Unknown email connection "nope"/)
    expect(mockCreateTransport).not.toHaveBeenCalled()
  })

  describe('default account (omitted `connection`)', () => {
    it('uses the sole configured account automatically when connection is omitted', async () => {
      saveEmailConnection({ name: 'Work Gmail', provider: 'gmail', emailAddress: 'me@gmail.com', appPassword: 'shh' })

      const result = await sendEmailTool.execute({ to: ['friend@example.com'], subject: 'Hi', body: 'x' }, ctx)

      expect(result).toBe('Sent to friend@example.com.')
      expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'me@gmail.com' }))
    })

    it('rejects with a clear, actionable error when connection is omitted, 2+ accounts exist, and none is marked default — without ever calling nodemailer', async () => {
      saveEmailConnection({ name: 'A', provider: 'gmail', emailAddress: 'a@gmail.com', appPassword: 'pw' })
      saveEmailConnection({ name: 'B', provider: 'custom', emailAddress: 'b@company.com', host: 'smtp.company.com', appPassword: 'pw' })

      await expect(
        sendEmailTool.execute({ to: ['x@x.com'], subject: 's', body: 'b' }, ctx)
      ).rejects.toThrow(/No email connection specified and no default account is configured/)
      expect(mockCreateTransport).not.toHaveBeenCalled()
    })

    it('uses the account marked default when connection is omitted and multiple accounts exist', async () => {
      saveEmailConnection({ name: 'A', provider: 'gmail', emailAddress: 'a@gmail.com', appPassword: 'pw' })
      const b = saveEmailConnection({
        name: 'B',
        provider: 'custom',
        emailAddress: 'b@company.com',
        appPassword: 'shh',
        host: 'smtp.company.com',
        port: 587
      })
      setDefaultEmailConnection(b.id)

      const result = await sendEmailTool.execute({ to: ['friend@example.com'], subject: 'Hi', body: 'x' }, ctx)

      expect(result).toBe('Sent to friend@example.com.')
      expect(mockCreateTransport).toHaveBeenCalledWith({
        host: 'smtp.company.com',
        port: 587,
        secure: undefined,
        auth: { user: 'b@company.com', pass: 'shh' }
      })
    })

    it("describe() shows the real resolved sending account in the confirmation text, not just the recipient", () => {
      saveEmailConnection({ name: 'Work Gmail', provider: 'gmail', emailAddress: 'me@gmail.com', appPassword: 'shh' })
      expect(sendEmailTool.describe?.({ to: ['a@x.com'], subject: 'Hi' })).toBe(
        'Send email from me@gmail.com to a@x.com: "Hi"'
      )
    })

    it('list_email_connections marks the default account in its output', async () => {
      saveEmailConnection({ name: 'Work Gmail', provider: 'gmail', emailAddress: 'me@gmail.com', appPassword: 'pw' })
      const result = await listEmailConnectionsTool.execute({}, ctx)
      expect(result).toBe('- Work Gmail: me@gmail.com (default)')
    })
  })

  it('verifyEmailConnection does a real login handshake with no message sent (Gmail)', async () => {
    await expect(
      verifyEmailConnection({ provider: 'gmail', emailAddress: 'me@gmail.com', appPassword: 'shh' })
    ).resolves.toBeUndefined()
    expect(mockVerify).toHaveBeenCalledTimes(1)
    expect(mockCreateTransport).toHaveBeenCalledWith({ service: 'gmail', auth: { user: 'me@gmail.com', pass: 'shh' } })
    expect(mockSendMail).not.toHaveBeenCalled()
  })

  it('verifyEmailConnection does a real login handshake for a custom SMTP server too, using its own host/port/secure', async () => {
    await expect(
      verifyEmailConnection({
        provider: 'custom',
        emailAddress: 'me@company.com',
        appPassword: 'shh',
        host: 'smtp.company.com',
        port: 465,
        secure: true
      })
    ).resolves.toBeUndefined()
    expect(mockCreateTransport).toHaveBeenCalledWith({
      host: 'smtp.company.com',
      port: 465,
      secure: true,
      auth: { user: 'me@company.com', pass: 'shh' }
    })
  })

  it('verifyEmailConnection surfaces a real auth failure', async () => {
    mockVerify.mockRejectedValue(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'))
    await expect(
      verifyEmailConnection({ provider: 'gmail', emailAddress: 'me@gmail.com', appPassword: 'wrong' })
    ).rejects.toThrow(/Username and Password not accepted/)
  })
})
