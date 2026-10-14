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
import { getSetting } from '../db/settings'

/**
 * TASKS.md #181: Markdown and PDF export now honor the same three-state tool-output display the live
 * chat view uses (Settings key `toolDisplayMode`, cycled via Cmd/Ctrl+O — see App.svelte/ChatView.svelte)
 * — read directly here since it's already persisted to app_settings and export runs in the main process
 * regardless of whether a chat window is even open. User-confirmed requirement, 2026-10-02: "Save
 * Session... should reflect this behavior." JSON export is deliberately exempt — see `sessionToJson`'s
 * own doc comment for why.
 */
export type ToolDisplayMode = 'hidden' | 'partial' | 'shown'

function currentToolDisplayMode(): ToolDisplayMode {
  const stored = getSetting('toolDisplayMode')
  return stored === 'hidden' || stored === 'partial' || stored === 'shown' ? stored : 'partial'
}

/** A pure-tool_result message is the continuation of the tool call just shown, not a new turn — same convention already used by App.svelte/prepare-context.ts. An `image` block (TASKS.md #82) rides alongside its `show_media` call's own `tool_result` in the same message, so it counts as a continuation too. A `user_note` (TASKS.md #158, a mid-run steering comment) is the same shape of continuation. */
function isPureToolResult(message: MessageRecord): boolean {
  return message.content.length > 0 && message.content.every((b) => b.type === 'tool_result' || b.type === 'image' || b.type === 'user_note')
}

/**
 * `null` means "omit this block entirely" — reachable for `tool_use`/a tool `tool_result` in
 * `'hidden'` mode (TASKS.md #181), and unconditionally for a `delegate_to_*` call's own `tool_result`
 * (TASKS.md #211 finding 3): that result is the specialist's own reply text, formatted for the
 * orchestrator's benefit — the specialist's own attributed `text` block already carries the same
 * words right after it in the transcript, same reasoning ChatView.svelte already applies live (see
 * its "Delegate calls need no result box of their own" comment). An `image` block is never affected
 * by `mode`, any value — "Hidden should show the image as it is important part of the output"
 * (explicit user decision, 2026-10-02): a content-type rule, not a per-tool one.
 */
function blockToMarkdown(block: ContentBlock, mode: ToolDisplayMode, delegateToolUseIds: ReadonlySet<string>): string | null {
  if (block.type === 'text') {
    const prefix = block.agentRole ? `*${roleLabel(block.agentRole)} agent:* ` : ''
    return `${prefix}${block.text}`
  }
  if (block.type === 'tool_use') {
    if (mode === 'hidden') return null
    const prefix = block.agentRole ? `*${roleLabel(block.agentRole)} agent* ` : ''
    const call = mode === 'shown' ? `**${block.name}**(${JSON.stringify(block.input)})` : `**${block.name}** (called)`
    return `> ${prefix}🔧 ${call}`
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
    return block.source === 'app' ? `> 🔍 ${block.text}` : `> 💬 **Mid-run note:** ${block.text}`
  }
  if (block.type === 'thinking') {
    // 'hidden'/'partial': same as the live view's collapsed thinking block — a marker that reasoning
    // happened, never the full text; 'shown' only unlocks the content, same as a tool result below.
    return mode === 'shown' ? `> 🧠 *Thinking:* ${block.text}` : '> 🧠 *Thinking* (collapsed)'
  }
  // tool_result
  if (delegateToolUseIds.has(block.toolUseId)) return null
  if (mode === 'hidden') return null
  const label = block.isError ? '⚠️ Error' : '→ Result'
  return mode === 'shown' ? `> ${label}: ${block.content}` : `> ${label.replace(/:.*$/, '')}`
}

/** Human-readable transcript — `## User`/`## Assistant` sections in order, tool calls and their results rendered inline. Tool output respects the same `toolDisplayMode` the live chat view uses (TASKS.md #181). */
export function sessionToMarkdown(session: SessionRecord, messages: MessageRecord[], mode: ToolDisplayMode = currentToolDisplayMode()): string {
  // Built once over the whole session, same as the live view's toolSegmentsById (App.svelte) — a
  // tool_result block only carries its toolUseId, not the tool's name, so matching it back to the
  // delegate_to_* call that produced it needs this id -> isDelegate lookup across every message.
  const delegateToolUseIds = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.name.startsWith('delegate_to_')) delegateToolUseIds.add(block.id)
    }
  }

  const lines: string[] = [`# ${session.title}`, '']
  for (const message of messages) {
    if (!isPureToolResult(message)) {
      lines.push(message.role === 'user' ? '## User' : '## Assistant', '')
    }
    for (const block of message.content) {
      const line = blockToMarkdown(block, mode, delegateToolUseIds)
      if (line !== null) lines.push(line, '')
    }
  }
  return lines.join('\n')
}

/** Full-fidelity dump of exactly what's in the DB — deliberately exempt from `toolDisplayMode` (TASKS.md #181): unlike Markdown/PDF (a human-readable transcript, where the display preference is a reasonable default), JSON's whole stated purpose is being the complete, unfiltered record. */
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
