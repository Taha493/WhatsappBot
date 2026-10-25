import { DateTime } from 'luxon'
import type { User } from '../db/schema.js'
import { TaskError } from '../tasks/errors.js'
import { groupForAgenda, renderTaskList } from '../tasks/render.js'
import type { TaskService } from '../tasks/service.js'
import { formatDue, localDayRange } from '../tasks/time.js'
import { texts } from './texts.js'
import type { UserService } from './users.js'

type Ctx = { user: User; zone: string; now: Date; tasks: TaskService; users: UserService }

/** Slash commands work without the LLM, so they keep working when AI quota runs out. */
export async function runCommand(text: string, ctx: Ctx): Promise<string> {
  const [rawName, ...args] = text.trim().split(/\s+/)
  const name = rawName!.toLowerCase()
  try {
    switch (name) {
      case '/help':
      case '/start':
        return texts.help
      case '/today':
        return await agenda(ctx, 1, `📋 *Today — ${DateTime.fromJSDate(ctx.now, { zone: ctx.zone }).toFormat('ccc d LLL')}*`)
      case '/week':
        return await agenda(ctx, 7, '📋 *Next 7 days*')
      case '/tasks':
      case '/list':
        return await allOpen(ctx)
      case '/done':
        return await done(ctx, args[0])
      case '/undo':
        return `↩️ ${(await ctx.tasks.undoLast(ctx.user.id)).description}`
      case '/settings':
        return settings(ctx)
      case '/reset':
        if (args[0]?.toLowerCase() === 'confirm') {
          await ctx.users.deleteAll(ctx.user.id)
          return texts.resetDone
        }
        return texts.resetConfirm
      default:
        return `I don't know the command ${name}.\n\n${texts.help}`
    }
  } catch (err) {
    if (err instanceof TaskError) return err.message
    throw err
  }
}

async function agenda({ user, zone, now, tasks }: Ctx, days: number, title: string): Promise<string> {
  const { from, to } = localDayRange(now, zone, 0, days)
  const [inRange, overdue] = await Promise.all([
    tasks.list(user.id, { from, to }),
    tasks.list(user.id, { overdueOnly: true }),
  ])
  const upcoming = groupForAgenda(inRange, zone, now).upcoming
  const lines = [title]
  lines.push(upcoming.length ? renderTaskList(upcoming, zone, now) : '_Nothing scheduled_ 🎉')
  if (overdue.length) lines.push('', '⚠️ *Overdue*', renderTaskList(overdue, zone, now))
  return lines.join('\n')
}

async function allOpen({ user, zone, now, tasks }: Ctx): Promise<string> {
  const list = await tasks.list(user.id, { status: 'open', limit: 50 })
  if (!list.length) return 'You have no open tasks 🎉'
  return `📋 *Open tasks (${list.length})*\n${renderTaskList(list, zone, now)}`
}

async function done({ user, zone, now, tasks }: Ctx, arg: string | undefined): Promise<string> {
  const number = Number(arg?.replace('#', ''))
  if (!Number.isInteger(number) || number <= 0) return 'Usage: /done 3 (the task number).'
  const { task, nextDue } = await tasks.complete(user.id, number, zone)
  return nextDue
    ? `✅ Done! Next time: ${formatDue(nextDue, task.allDay, zone, now)}.`
    : `✅ "${task.title}" marked as completed.`
}

function settings({ user, zone, now }: Ctx): string {
  const local = DateTime.fromJSDate(now, { zone }).toFormat('h:mm a')
  return [
    '⚙️ *Settings*',
    `• Timezone: *${zone}*${user.timezone ? '' : ' (default)'} — it's ${local} there now`,
    `• Daily summary: *${user.digestEnabled ? `on, ${user.digestTime?.slice(0, 5)}` : 'off'}*`,
    '',
    'To change them, just say e.g. _"I\'m in London"_ or _"Send me a daily summary at 8am"_ / _"Stop the daily summary"_.',
  ].join('\n')
}
