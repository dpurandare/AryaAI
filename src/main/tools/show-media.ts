import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Tool } from './types'

/**
 * TASKS.md #82, scope settled per its own doc comment: images only,
 * display-only (no model vision — see Fork 1), inline base64 (see Fork 2) —
 * the smaller, well-scoped first slice; video and model-vision are
 * deliberately separate, later items.
 */
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}

/**
 * Fine for a small chart/screenshot; bad for anything much bigger — inline
 * base64 stores the full encoded bytes in every copy of the message
 * (SQLite row, in-memory transcript, every stream event), per Fork 2's own
 * documented tradeoff. A real cap, not a guess: keeps a single oversized
 * image from silently bloating a session's whole message history.
 */
const MAX_IMAGE_BYTES = 5_000_000

/**
 * The marker `dispatchTool` (orchestrator.ts) looks for to recognize this
 * tool's result as image data to split into a separate, UI-only `image`
 * content block, rather than a normal tool_result string — see its own doc
 * comment for why the raw base64 must never be sent back to the model as
 * ordinary tool_result content (it would balloon every later request's
 * token count for zero benefit; the model doesn't need to see the bytes
 * for a display-only feature).
 */
export const SHOW_MEDIA_MARKER = '__sachivShowMedia'

export interface ShowMediaPayload {
  [SHOW_MEDIA_MARKER]: true
  path: string
  mimeType: string
  dataBase64: string
  /** Extra text for the MODEL only (the user sees just the image) — e.g. a reminder that it has not seen the picture. */
  note?: string
}

export const showMediaTool: Tool = {
  name: 'show_media',
  description:
    'Display an image that already exists in the workspace directly in the chat, for the user to see — ' +
    'e.g. a chart or screenshot a previous step generated. Images only (.png/.jpg/.jpeg/.gif/.webp/.svg) — ' +
    'video is not supported yet. You will not see the image yourself; this is for the user, not for your ' +
    'own analysis.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path to an existing image file, relative to the workspace root' } },
    required: ['path']
  },
  mutates: false,
  async execute(input, ctx) {
    const relPath = String(input.path ?? '')
    if (!relPath.trim()) throw new Error('No path given.')
    const path = ctx.workspaceGuard.assertWithinWorkspace(relPath)
    const ext = extname(path).toLowerCase()
    const mimeType = IMAGE_MIME_TYPES[ext]
    if (!mimeType) {
      throw new Error(
        `"${ext || relPath}" is not a supported image type — only ${Object.keys(IMAGE_MIME_TYPES).join(', ')} can be shown.`
      )
    }
    const info = await stat(path)
    if (info.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image is ${info.size} bytes, over the ${MAX_IMAGE_BYTES}-byte inline display limit.`)
    }
    const bytes = await readFile(path)
    const payload: ShowMediaPayload = {
      [SHOW_MEDIA_MARKER]: true,
      path: relPath,
      mimeType,
      dataBase64: bytes.toString('base64')
    }
    return JSON.stringify(payload)
  }
}
