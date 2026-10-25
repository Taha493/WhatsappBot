export type QuickAction =
  | { kind: 'done' }
  | { kind: 'snooze'; minutes: number }
  | { kind: 'tomorrow' }

const DONE = /^(done|did it|completed?|finished|ok done|✅|✔️|👍)[.!]*$/i
const SNOOZE = /^(?:snooze|later|remind me later)(?:\s+(?:for\s+)?(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?))?[.!]*$/i
const TOMORROW = /^(tomorrow|remind me tomorrow)[.!]*$/i

/**
 * Parses a reply to a reminder: "done", "snooze", "snooze 30m", "snooze 2 hours", "tomorrow".
 * Anything else returns null and goes to the assistant.
 */
export function parseQuickAction(text: string): QuickAction | null {
  const value = text.trim()
  if (DONE.test(value)) return { kind: 'done' }
  if (TOMORROW.test(value)) return { kind: 'tomorrow' }
  const snooze = SNOOZE.exec(value)
  if (snooze) {
    if (!snooze[1]) return { kind: 'snooze', minutes: 60 }
    const amount = Number(snooze[1])
    const minutes = snooze[2]!.toLowerCase().startsWith('h') ? amount * 60 : amount
    return minutes > 0 && minutes <= 7 * 24 * 60 ? { kind: 'snooze', minutes } : null
  }
  return null
}
