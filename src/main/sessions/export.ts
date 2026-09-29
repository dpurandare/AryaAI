import { dialog, ipcMain, BrowserWindow } from 'electron'
import type { IpcMainEvent } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { roleLabel } from '@shared/agents'
import type { ContentBlock } from '@shared/protocol'
import { IpcChannel, type SessionExportResult } from '@shared/ipc-contract'
import { listMessages, type MessageRecord } from '../db/messages'
import { listSessions, type SessionRecord } from '../db/sessions'

/** A pure-tool_result message is the continuation of the tool call just shown, not a new turn — same convention already used by App.svelte/prepare-context.ts. An `image` block (TASKS.md #82) rides alongside its `show_media` call's own `tool_result` in the same message, so it counts as a continuation too. A `user_note` (TASKS.md #158, a mid-run steering comment) is the same shape of continuation. */
function isPureToolResult(message: MessageRecord): boolean {
  return message.content.length > 0 && message.content.every((b) => b.type === 'tool_result' || b.type === 'image' || b.type === 'user_note')
}

function blockToMarkdown(block: ContentBlock): string {
  if (block.type === 'text') {
    const prefix = block.agentRole ? `*${roleLabel(block.agentRole)} agent:* ` : ''
    return `${prefix}${block.text}`
  }
  if (block.type === 'tool_use') {
    const prefix = block.agentRole ? `*${roleLabel(block.agentRole)} agent* ` : ''
    return `> ${prefix}🔧 **${block.name}**(${JSON.stringify(block.input)})`
  }
  if (block.type === 'warning') {
    return `> ⚠️ ${block.message}`
  }
  if (block.type === 'image') {
    // The path only, not the base64 payload — keeps a Markdown export
    // lightweight rather than inlining a multi-MB data URI into a text file.
    return `> 🖼️ Displayed image: ${block.path}`
  }
  if (block.type === 'user_note') {
    return `> 💬 **Mid-run note:** ${block.text}`
  }
  const label = block.isError ? '⚠️ Error' : '→ Result'
  return `> ${label}: ${block.content}`
}

/** Human-readable transcript — `## User`/`## Assistant` sections in order, tool calls and their results rendered inline. */
export function sessionToMarkdown(session: SessionRecord, messages: MessageRecord[]): string {
  const lines: string[] = [`# ${session.title}`, '']
  for (const message of messages) {
    if (!isPureToolResult(message)) {
      lines.push(message.role === 'user' ? '## User' : '## Assistant', '')
    }
    for (const block of message.content) {
      lines.push(blockToMarkdown(block), '')
    }
  }
  return lines.join('\n')
}

/** Full-fidelity dump of exactly what's in the DB. */
export function sessionToJson(session: SessionRecord, messages: MessageRecord[]): string {
  return JSON.stringify({ session, messages }, null, 2)
}

/** Strips characters invalid in filenames on any of the 3 target platforms. */
function sanitizeFilename(title: string): string {
  return title.replace(/[/\\:*?"<>|]/g, '_').trim() || 'session'
}

// Guards against a print page that never signals readiness (e.g. a JS error
// before it gets to notifyPrintReady) — export still completes instead of
// leaving the "Save as" action hung forever.
const PRINT_READY_TIMEOUT_MS = 10_000

/**
 * Renders a session's transcript as PDF via Electron's own
 * `webContents.printToPDF()` — no PDF library dependency, and it reuses the
 * exact same (already sanitized) markdown/KaTeX rendering the live chat
 * view uses, off a hidden window loading the app's own print.html page
 * (src/renderer/src/lib/components/PrintView.svelte).
 */
async function renderSessionToPdf(sessionId: string): Promise<Buffer> {
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  try {
    const ready = new Promise<void>((resolve) => {
      const handler = (event: IpcMainEvent): void => {
        if (event.sender !== printWindow.webContents) return
        ipcMain.off(IpcChannel.PrintReady, handler)
        resolve()
      }
      ipcMain.on(IpcChannel.PrintReady, handler)
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      await printWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/print.html?sessionId=${encodeURIComponent(sessionId)}`)
    } else {
      await printWindow.loadFile(join(__dirname, '../renderer/print.html'), { query: { sessionId } })
    }

    await Promise.race([ready, new Promise<void>((resolve) => setTimeout(resolve, PRINT_READY_TIMEOUT_MS))])

    return await printWindow.webContents.printToPDF({ printBackground: true })
  } finally {
    printWindow.destroy()
  }
}

/** Prompts the user with a native save dialog and writes the session as Markdown, JSON, or PDF depending on the extension they chose. */
export async function exportSession(
  sessionId: string,
  window: BrowserWindow | null
): Promise<SessionExportResult> {
  const session = listSessions().find((s) => s.id === sessionId)
  if (!session) {
    throw new Error(`Unknown session "${sessionId}".`)
  }
  const messages = listMessages(sessionId)

  const dialogOptions = {
    defaultPath: `${sanitizeFilename(session.title)}.md`,
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'PDF', extensions: ['pdf'] }
    ]
  }
  const { canceled, filePath } = window
    ? await dialog.showSaveDialog(window, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions)
  if (canceled || !filePath) {
    return { cancelled: true }
  }

  if (filePath.toLowerCase().endsWith('.pdf')) {
    const pdf = await renderSessionToPdf(sessionId)
    await writeFile(filePath, pdf)
    return { cancelled: false, path: filePath }
  }

  const content = filePath.toLowerCase().endsWith('.json')
    ? sessionToJson(session, messages)
    : sessionToMarkdown(session, messages)
  await writeFile(filePath, content, 'utf-8')
  return { cancelled: false, path: filePath }
}
