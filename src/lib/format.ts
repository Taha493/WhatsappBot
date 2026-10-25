/** WhatsApp's per-message limit is 4096 characters; stay below it. */
export const MAX_MESSAGE_LENGTH = 3500

/**
 * Converts common Markdown that LLMs produce into WhatsApp formatting:
 * **bold** / __bold__ → *bold*, headings → *bold*, [text](url) → text (url), "* item" → "• item".
 */
export function toWhatsApp(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)')
    .replace(/^(\s*)[*-]\s+/gm, '$1• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Splits long text into WhatsApp-sized chunks, preferring paragraph and line breaks. */
export function splitMessage(text: string, max = MAX_MESSAGE_LENGTH): string[] {
  const chunks: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let cut = window.lastIndexOf('\n\n')
    if (cut < max * 0.5) cut = window.lastIndexOf('\n')
    if (cut < max * 0.5) cut = window.lastIndexOf(' ')
    if (cut <= 0) cut = max
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks
}
