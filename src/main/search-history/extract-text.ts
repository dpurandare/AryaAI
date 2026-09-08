import type { ContentBlock } from '@shared/protocol'

/**
 * Pulls plain, embeddable text out of a message's content blocks — `.text`
 * from text blocks, `.content` from tool_result blocks. `tool_use` blocks
 * carry no free text (just a name + structured input) and are skipped.
 * A message that's entirely tool_use (no accompanying text) yields '' and
 * is skipped from indexing by the caller — nothing meaningful to embed.
 */
export function extractSearchableText(content: ContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool_result') return block.content
      return ''
    })
    .filter((text) => text.length > 0)
    .join('\n')
    .trim()
}
