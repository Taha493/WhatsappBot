import type { ConversationLog } from '../core/conversation.js'
import type { Outbound } from '../core/outbound.js'
import type { UserService } from '../core/users.js'
import type { User } from '../db/schema.js'
import type { Logger } from '../lib/logger.js'
import type { DueReminder, ReminderService } from '../tasks/reminders.js'
import { formatDue, type Clock } from '../tasks/time.js'

/** Reminders up to this late are still sent individually (with a "sent late" note). */
export const LATE_LIMIT_MS = 2 * 60 * 60_000
const LATE_NOTE_MS = 5 * 60_000

type Deps = {
  reminders: ReminderService
  users: UserService
  outbound: Outbound
  conversation: ConversationLog
  clock: Clock
  logger: Logger
}

/** Claims due reminders and delivers them. Missed ones (bot was offline) are combined. */
export class ReminderDispatcher {
  constructor(private readonly d: Deps) {}

  async run(): Promise<number> {
    const due = await this.d.reminders.claimDue()
    if (due.length === 0) return 0
    const now = this.d.clock().getTime()

    const missedByUser = new Map<string, DueReminder[]>()
    let delivered = 0
    for (const item of due) {
      if (item.task.status !== 'open') {
        await this.d.reminders.markCancelled(item.reminder.id)
        continue
      }
      const lateness = now - item.reminder.remindAt.getTime()
      if (lateness > LATE_LIMIT_MS) {
        missedByUser.set(item.user.id, [...(missedByUser.get(item.user.id) ?? []), item])
        continue
      }
      if (await this.deliver(item.user, [item], this.reminderText(item, lateness > LATE_NOTE_MS))) delivered++
    }
    for (const items of missedByUser.values()) {
      if (await this.deliver(items[0]!.user, items, this.missedText(items))) delivered += items.length
    }
    return delivered
  }

  private reminderText({ task, user }: DueReminder, late: boolean): string {
    const zone = this.d.users.zoneOf(user)
    const now = this.d.clock()
    const lines = [`⏰ *Reminder:* ${task.title}`]
    if (task.dueAt) lines.push(`Due ${formatDue(task.dueAt, task.allDay, zone, now)}`)
    if (task.notes) lines.push(`_${task.notes}_`)
    if (late) lines.push('_(Sent late — I was offline for a bit.)_')
    lines.push('', 'Reply to this message with *done*, *snooze 1h* or *tomorrow*.')
    return lines.join('\n')
  }

  private missedText(items: DueReminder[]): string {
    const zone = this.d.users.zoneOf(items[0]!.user)
    const now = this.d.clock()
    const lines = items.map(
      ({ task, reminder }) =>
        `• *#${task.number}* ${task.title} — was due ${formatDue(reminder.remindAt, false, zone, now)}`,
    )
    return [
      '⏰ I was offline for a while and missed these reminders, sorry:',
      ...lines,
      '',
      'Tell me if you want to reschedule any of them.',
    ].join('\n')
  }

  private async deliver(user: User, items: DueReminder[], text: string): Promise<boolean> {
    try {
      const sent = await this.d.outbound.sendText({ id: user.jid, phone: user.phone ?? undefined }, text)
      // Quote-reply actions only make sense for a single reminder.
      const messageId = items.length === 1 ? sent.id || null : null
      for (const { reminder } of items) await this.d.reminders.markSent(reminder.id, messageId)
      await this.d.conversation.recordOutgoing(user.id, { waMessageId: messageId, type: 'reminder', content: text })
      return true
    } catch (err) {
      this.d.logger.warn({ err, user: user.id }, 'Reminder delivery failed')
      for (const { reminder } of items) await this.d.reminders.markFailed(reminder, String(err))
      return false
    }
  }
}
