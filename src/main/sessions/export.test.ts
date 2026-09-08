import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageRecord } from '../db/messages'
import type { SessionRecord } from '../db/sessions'

// export.ts imports `electron` (dialog) at module scope — same hazard
// documented in data/connections.test.ts/mcp/config.test.ts. Mocked here
// rather than importing the real one; `writeFile` is mocked too so tests
// never touch the real filesystem.
const mockShowSaveDialog = vi.fn()
const mockWriteFile = vi.fn()

vi.mock('electron', () => ({
  dialog: { showSaveDialog: mockShowSaveDialog }
}))
vi.mock('node:fs/promises', () => ({ writeFile: mockWriteFile }))

const mockListSessions = vi.fn()
const mockListMessages = vi.fn()
vi.mock('../db/sessions', () => ({ listSessions: mockListSessions }))
vi.mock('../db/messages', () => ({ listMessages: mockListMessages }))

const { exportSession, sessionToJson, sessionToMarkdown } = await import('./export')

const session: SessionRecord = {
  id: 's1',
  title: 'Test Session',
  createdAt: 1000,
  updatedAt: 2000
}

describe('sessionToMarkdown', () => {
  it('renders a title and User/Assistant sections for plain text turns', () => {
    const messages: MessageRecord[] = [
      { id: 'm1', sessionId: 's1', role: 'user', content: [{ type: 'text', text: 'Hello there' }], createdAt: 1 },
      { id: 'm2', sessionId: 's1', role: 'assistant', content: [{ type: 'text', text: 'Hi! How can I help?' }], createdAt: 2 }
    ]
    const md = sessionToMarkdown(session, messages)
    expect(md).toContain('# Test Session')
    expect(md).toContain('## User')
    expect(md).toContain('Hello there')
    expect(md).toContain('## Assistant')
    expect(md).toContain('Hi! How can I help?')
  })

  it('prefixes delegated text/tool_use blocks with the agent role', () => {
    const messages: MessageRecord[] = [
      {
        id: 'm1',
        sessionId: 's1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Writing the file now.', agentRole: 'coding' }],
        createdAt: 1
      }
    ]
    expect(sessionToMarkdown(session, messages)).toContain('*Coding agent:* Writing the file now.')
  })

  it('renders a tool_use block as a fenced call and does not give a pure tool_result message its own heading', () => {
    const messages: MessageRecord[] = [
      {
        id: 'm1',
        sessionId: 's1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'a.txt' } }],
        createdAt: 1
      },
      {
        id: 'm2',
        sessionId: 's1',
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'Wrote 1 file.' }],
        createdAt: 2
      }
    ]
    const md = sessionToMarkdown(session, messages)
    expect(md).toContain('🔧 **write_file**({"path":"a.txt"})')
    expect(md).toContain('→ Result: Wrote 1 file.')
    // The tool_result message must not start a new "## User" section.
    expect(md.match(/## User/g)).toBeNull()
  })

  it('marks an error tool_result distinctly from a successful one', () => {
    const messages: MessageRecord[] = [
      {
        id: 'm1',
        sessionId: 's1',
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'boom', isError: true }],
        createdAt: 1
      }
    ]
    expect(sessionToMarkdown(session, messages)).toContain('⚠️ Error: boom')
  })
})

describe('sessionToJson', () => {
  it('round-trips to valid JSON containing the real session and messages', () => {
    const messages: MessageRecord[] = [
      { id: 'm1', sessionId: 's1', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: 1 }
    ]
    const parsed = JSON.parse(sessionToJson(session, messages))
    expect(parsed.session).toEqual(session)
    expect(parsed.messages).toEqual(messages)
  })
})

describe('exportSession', () => {
  const messages: MessageRecord[] = [
    { id: 'm1', sessionId: 's1', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: 1 }
  ]

  beforeEach(() => {
    mockShowSaveDialog.mockReset()
    mockWriteFile.mockReset()
    mockListSessions.mockReset().mockReturnValue([session])
    mockListMessages.mockReset().mockReturnValue(messages)
  })

  it('writes Markdown when the user picks a .md path', async () => {
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/out.md' })
    const result = await exportSession('s1', null)
    expect(result).toEqual({ cancelled: false, path: '/tmp/out.md' })
    expect(mockWriteFile).toHaveBeenCalledWith('/tmp/out.md', expect.stringContaining('# Test Session'), 'utf-8')
  })

  it('writes JSON when the user picks a .json path', async () => {
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/out.json' })
    await exportSession('s1', null)
    const written = mockWriteFile.mock.calls[0][1] as string
    expect(() => JSON.parse(written)).not.toThrow()
    expect(JSON.parse(written).session).toEqual(session)
  })

  it('defaults to Markdown when the chosen path has no recognized extension', async () => {
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/out' })
    await exportSession('s1', null)
    expect(mockWriteFile.mock.calls[0][1]).toContain('# Test Session')
  })

  it('returns cancelled and writes nothing when the dialog is dismissed', async () => {
    mockShowSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    const result = await exportSession('s1', null)
    expect(result).toEqual({ cancelled: true })
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('throws a clear error for an unknown session id', async () => {
    mockListSessions.mockReturnValue([])
    await expect(exportSession('nope', null)).rejects.toThrow(/Unknown session/)
  })

  it('passes the given window through to showSaveDialog when provided', async () => {
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/out.md' })
    const fakeWindow = { id: 'fake-window' } as never
    await exportSession('s1', fakeWindow)
    expect(mockShowSaveDialog).toHaveBeenCalledWith(fakeWindow, expect.any(Object))
  })
})
