import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { AGENT_ROLE_LABELS } from '@shared/agents'
import type { ContentBlock } from '@shared/protocol'
import type { SessionExportResult } from '@shared/ipc-contract'
import { listMessages, type MessageRecord } from '../db/messages'
import { listSessions, type SessionRecord } from '../db/sessions'

/** A pure-tool_result message is the continuation of the tool call just shown, not a new turn — same convention already used by App.svelte/prepare-context.ts. */
function isPureToolResult(message: MessageRecord): boolean {
  return message.content.length > 0 && message.content.every((b) => b.type === 'tool_result')
}

function blockToMarkdown(block: ContentBlock): string {
  if (block.type === 'text') {
    const prefix = block.agentRole ? `*${AGENT_ROLE_LABELS[block.agentRole]} agent:* ` : ''
    return `${prefix}${block.text}`
  }
  if (block.type === 'tool_use') {
    const prefix = block.agentRole ? `*${AGENT_ROLE_LABELS[block.agentRole]} agent* ` : ''
    return `> ${prefix}🔧 **${block.name}**(${JSON.stringify(block.input)})`
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

/** Prompts the user with a native save dialog and writes the session as Markdown or JSON depending on the extension they chose. */
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
      { name: 'JSON', extensions: ['json'] }
    ]
  }
  const { canceled, filePath } = window
    ? await dialog.showSaveDialog(window, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions)
  if (canceled || !filePath) {
    return { cancelled: true }
  }

  const content = filePath.toLowerCase().endsWith('.json')
    ? sessionToJson(session, messages)
    : sessionToMarkdown(session, messages)
  await writeFile(filePath, content, 'utf-8')
  return { cancelled: false, path: filePath }
}
