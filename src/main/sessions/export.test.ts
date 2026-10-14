import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageRecord } from '../db/messages'
import type { SessionRecord } from '../db/sessions'

// export.ts imports `electron` (dialog, ipcMain, BrowserWindow) at module
// scope — same hazard documented in data/connections.test.ts/mcp/config.test.ts.
// Mocked here rather than importing the real one; `writeFile` is mocked too
// so tests never touch the real filesystem. The mock BrowserWindow/ipcMain
// pair simulates just enough of the real PDF flow (a hidden window that
// eventually fires the app's own PrintReady channel) for the PDF path's
// tests below, without a real Chromium renderer.
const mockShowSaveDialog = vi.fn()
const mockWriteFile = vi.fn()
const mockPrintToPDF = vi.fn()
const mockLoadFile = vi.fn()
const mockDestroy = vi.fn()
const createdPrintWindows: { webContents: { printToPDF: typeof mockPrintToPDF } }[] = []

const ipcMainHandlers = new Map<string, Set<(event: { sender: unknown }) => void>>()
const mockIpcMain = {
  on: (channel: string, handler: (event: { sender: unknown }) => void): void => {
    if (!ipcMainHandlers.has(channel)) ipcMainHandlers.set(channel, new Set())
    ipcMainHandlers.get(channel)!.add(handler)
  },
  off: (channel: string, handler: (event: { sender: unknown }) => void): void => {
    ipcMainHandlers.get(channel)?.delete(handler)
  }
}

class MockBrowserWindow {
  webContents = { printToPDF: mockPrintToPDF }
  loadFile = mockLoadFile
  loadURL = vi.fn()
  destroy = mockDestroy
  constructor() {
    createdPrintWindows.push(this)
  }
}

vi.mock('electron', () => ({
  dialog: { showSaveDialog: mockShowSaveDialog },
  ipcMain: mockIpcMain,
  BrowserWindow: MockBrowserWindow
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('node:fs/promises', () => ({ writeFile: mockWriteFile }))

const mockListSessions = vi.fn()
const mockListMessages = vi.fn()
// Defaults to 'partial' (undefined -> currentToolDisplayMode()'s own fallback) — tests exercising full
// tool content pass 'shown' explicitly to sessionToMarkdown rather than relying on this mock's value.
const mockGetSetting = vi.fn().mockReturnValue(undefined)
vi.mock('../db/sessions', () => ({ listSessions: mockListSessions }))
vi.mock('../db/messages', () => ({ listMessages: mockListMessages }))
vi.mock('../db/settings', () => ({ getSetting: mockGetSetting }))

const { IpcChannel } = await import('@shared/ipc-contract')
const { exportSession, sessionToJson, sessionToMarkdown } = await import('./export')

/** Simulates the print page's own `notifyPrintReady()` call for the most recently created hidden window. */
function firePrintReady(): void {
  const window = createdPrintWindows[createdPrintWindows.length - 1]
  for (const handler of ipcMainHandlers.get(IpcChannel.PrintReady) ?? []) {
    handler({ sender: window.webContents })
  }
}

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
    expect(sessionToMarkdown(session, messages)).toContain('*Developer agent:* Writing the file now.')
  })

  it('labels a block from a role that no longer resolves with a humanized id, never "undefined" (a deleted user-defined role)', () => {
    const messages: MessageRecord[] = [
      {
        id: 'm1',
        sessionId: 's1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Here is the report.', agentRole: 'sql-reporter' }],
        createdAt: 1
      }
    ]
    const md = sessionToMarkdown(session, messages)
    expect(md).toContain('*Sql Reporter agent:* Here is the report.')
    expect(md).not.toContain('undefined')
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
    const md = sessionToMarkdown(session, messages, 'shown')
    expect(md).toContain('🔧 **write_file**({"path":"a.txt"})')
    expect(md).toContain('→ Result: Wrote 1 file.')
    // The tool_result message must not start a new "## User" section.
    expect(md.match(/## User/g)).toBeNull()
  })

  // TASKS.md #211 finding 3: confirmed live that the specialist's own reply text is stored twice —
  // once as its own `text` message, once again wrapped as the `delegate_to_*` call's `tool_result` —
  // and that ChatView.svelte already special-cases this live (never renders a resolved delegate
  // call's tool_result at all). Markdown/PDF export had no such exclusion before this fix.
  it('omits a delegate_to_* call\'s own tool_result — the specialist\'s text block right after it already carries the same reply', () => {
    const messages: MessageRecord[] = [
      {
        id: 'm1',
        sessionId: 's1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'delegate_to_coding', input: { task: 'write a script' } }],
        createdAt: 1
      },
      {
        id: 'm2',
        sessionId: 's1',
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'I wrote the script to code/print_numbers.py and ran it.' }],
        createdAt: 2
      },
      {
        id: 'm3',
        sessionId: 's1',
        role: 'assistant',
        content: [{ type: 'text', text: 'I wrote the script to code/print_numbers.py and ran it.', agentRole: 'coding' }],
        createdAt: 3
      }
    ]
    const md = sessionToMarkdown(session, messages, 'shown')
    expect(md).toContain('🔧 **delegate_to_coding**')
    expect(md.match(/I wrote the script to code\/print_numbers\.py and ran it\./g)).toHaveLength(1)
    expect(md).not.toContain('→ Result')
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
    expect(sessionToMarkdown(session, messages, 'shown')).toContain('⚠️ Error: boom')
  })

  describe('toolDisplayMode (TASKS.md #181)', () => {
    const toolMessages: MessageRecord[] = [
      {
        id: 'm1',
        sessionId: 's1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'find_files', input: { pattern: '*.ts' } }],
        createdAt: 1
      },
      {
        id: 'm2',
        sessionId: 's1',
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'lots of real file paths here' }],
        createdAt: 2
      },
      {
        id: 'm3',
        sessionId: 's1',
        role: 'assistant',
        content: [{ type: 'image', toolUseId: 'call_2', path: 'chart.png', mimeType: 'image/png', dataBase64: 'abc123' }],
        createdAt: 3
      }
    ]

    it("'hidden' omits tool_use/tool_result entirely but still shows the image — \"Hidden should show the image as it is important part of the output\"", () => {
      const md = sessionToMarkdown(session, toolMessages, 'hidden')
      expect(md).not.toContain('find_files')
      expect(md).not.toContain('lots of real file paths here')
      expect(md).toContain('🖼️ Displayed image: chart.png')
    })

    it("'partial' shows the tool name and a done/error status, never the real input or result content", () => {
      const md = sessionToMarkdown(session, toolMessages, 'partial')
      expect(md).toContain('find_files')
      expect(md).toContain('(called)')
      expect(md).not.toContain('*.ts') // the real input, never shown in partial mode
      expect(md).toContain('→ Result')
      expect(md).not.toContain('lots of real file paths here') // the real result, never shown in partial mode
      expect(md).toContain('🖼️ Displayed image: chart.png')
    })

    it("'shown' (the default behavior tested above) shows everything, same as before this feature existed", () => {
      const md = sessionToMarkdown(session, toolMessages, 'shown')
      expect(md).toContain('*.ts')
      expect(md).toContain('lots of real file paths here')
    })

    it('exportSession reads the persisted toolDisplayMode setting for Markdown exports, not a hardcoded default', async () => {
      mockListSessions.mockReturnValue([session])
      mockListMessages.mockReturnValue(toolMessages)
      mockGetSetting.mockReturnValueOnce('hidden')
      mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/out.md' })

      await exportSession('s1', null)

      const written = mockWriteFile.mock.calls[0][1] as string
      expect(written).not.toContain('find_files')
      expect(written).toContain('🖼️ Displayed image: chart.png')
    })
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
    mockPrintToPDF.mockReset().mockResolvedValue(Buffer.from('%PDF-fake'))
    mockLoadFile.mockReset().mockResolvedValue(undefined)
    mockDestroy.mockReset()
    createdPrintWindows.length = 0
    ipcMainHandlers.clear()
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

  it('renders and writes a PDF when the user picks a .pdf path, off a hidden window that signals readiness itself', async () => {
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/out.pdf' })
    const resultPromise = exportSession('s1', null)

    await vi.waitFor(() => expect(createdPrintWindows).toHaveLength(1))
    expect(mockLoadFile).toHaveBeenCalledWith(
      expect.stringContaining('print.html'),
      expect.objectContaining({ query: { sessionId: 's1' } })
    )
    firePrintReady()

    const result = await resultPromise
    expect(result).toEqual({ cancelled: false, path: '/tmp/out.pdf' })
    expect(mockPrintToPDF).toHaveBeenCalledWith(expect.objectContaining({ printBackground: true }))
    expect(mockWriteFile).toHaveBeenCalledWith('/tmp/out.pdf', Buffer.from('%PDF-fake'))
    expect(mockDestroy).toHaveBeenCalled()
  })

  it('ignores a PrintReady signal from an unrelated window before proceeding', async () => {
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/out.pdf' })
    const resultPromise = exportSession('s1', null)
    await vi.waitFor(() => expect(createdPrintWindows).toHaveLength(1))

    for (const handler of ipcMainHandlers.get(IpcChannel.PrintReady) ?? []) {
      handler({ sender: { unrelated: true } })
    }
    expect(mockPrintToPDF).not.toHaveBeenCalled()

    firePrintReady()
    await resultPromise
    expect(mockPrintToPDF).toHaveBeenCalledTimes(1)
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
