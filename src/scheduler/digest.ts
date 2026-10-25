import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { ConversationLog } from '../core/conversation.js'
import type { Outbound } from '../core/outbound.js'
import type { UserService } from '../core/users.js'
import type { Db } from '../db/client.js'
import { users, type User } from '../db/schema.js'
import type { Logger } from '../lib/logger.js'
import { groupForAgenda, renderTaskList } from '../tasks/render.js'
import type { TaskService } from '../tasks/service.js'
import { localDayRange, type Clock } from '../tasks/time.js'

/** The digest is only sent within this window after its time (e.g. not at 6 PM if the bot was down all day). */
const SEND_WINDOW_HOURS = 3

type Deps = {
  db: Db
  users: UserService
  tasks: TaskService
  outbound: Outbound
  conversation: ConversationLog
  clock: Clock
  logger: Logger
}

/** Sends each user's morning summary once per local day, at their chosen time. */
export class DigestSender {
  constructor(private readonly d: Deps) {}

  async run(): Promise<number> {
    const candidates = await this.d.db
      .select()
      .from(users)
      .where(and(eq(users.digestEnabled, true), isNotNull(users.digestTime)))
    let sent = 0
    for (const user of candidates) {
      const zone = this.d.users.zoneOf(user)
      const local = DateTime.fromJSDate(this.d.clock(), { zone })
      const [h, m] = user.digestTime!.split(':').map(Number)
      const scheduled = local.set({ hour: h, minute: m, second: 0, millisecond: 0 })
      if (local < scheduled || local > scheduled.plus({ hours: SEND_WINDOW_HOURS })) continue

      // Claim today's digest atomically so it's never sent twice.
      const today = local.toISODate()!
      const claimed = await this.d.db
        .update(users)
        .set({ lastDigestOn: today })
        .where(and(eq(users.id, user.id), sql`${users.lastDigestOn} is distinct from ${today}`))
        .returning({ id: users.id })
      if (claimed.length === 0) continue

      try {
        const text = await this.render(user, zone)
        const ref = await this.d.outbound.sendText({ id: user.jid, phone: user.phone ?? undefined }, text)
        await this.d.conversation.recordOutgoing(user.id, { waMessageId: ref.id || null, type: 'digest', content: text })
        sent++
      } catch (err) {
        this.d.logger.warn({ err, user: user.id }, 'Digest delivery failed')
      }
    }
    return sent
  }

  async render(user: User, zone: string): Promise<string> {
    const now = this.d.clock()
    const { from, to } = localDayRange(now, zone)
    const [today, overdue] = await Promise.all([
      this.d.tasks.list(user.id, { from, to }),
      this.d.tasks.list(user.id, { overdueOnly: true }),
    ])
    const upcoming = groupForAgenda(today, zone, now).upcoming
    const greeting = user.name ? `☀️ Good morning, ${user.name}!` : '☀️ Good morning!'
    const lines = [greeting]
    if (!upcoming.length && !overdue.length) {
      lines.push('Nothing scheduled for today 🎉 Tell me if you want to plan something.')
      return lines.join('\n')
    }
    lines.push('', upcoming.length ? `📋 *Today (${upcoming.length})*` : '📋 *Today*: nothing scheduled')
    if (upcoming.length) lines.push(renderTaskList(upcoming, zone, now))
    if (overdue.length) lines.push('', `⚠️ *Overdue (${overdue.length})*`, renderTaskList(overdue, zone, now))
    lines.push('', 'Have a productive day! 💪')
    return lines.join('\n')
  }
}
