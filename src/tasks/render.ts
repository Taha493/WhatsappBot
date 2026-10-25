import type { Reminder, Task } from '../db/schema.js'
import { formatDue, isOverdue } from './time.js'

type RenderTask = Task & { reminders?: Reminder[] }

/** One WhatsApp line per task: "*#3* Submit assignment — tomorrow, 10:00 AM ⏰" */
export function renderTaskLine(task: RenderTask, zone: string, now: Date): string {
  const parts = [`*#${task.number}* ${task.title}`]
  if (task.dueAt) {
    const overdue = task.status === 'open' && isOverdue(task.dueAt, task.allDay, zone, now)
    parts.push(`— ${formatDue(task.dueAt, task.allDay, zone, now)}${overdue ? ' ⚠️ _overdue_' : ''}`)
  }
  const flags = [
    task.priority === 'high' ? '❗' : '',
    task.recurrence ? '🔁' : '',
    task.reminders?.length ? '⏰' : '',
    task.status === 'done' ? '✅' : '',
  ].join('')
  return flags ? `${parts.join(' ')} ${flags}` : parts.join(' ')
}

export function renderTaskList(list: RenderTask[], zone: string, now: Date): string {
  return list.map((t) => renderTaskLine(t, zone, now)).join('\n')
}

/** Splits open tasks into overdue / in range, for /today, /week and the digest. */
export function groupForAgenda(list: RenderTask[], zone: string, now: Date) {
  const overdue = list.filter((t) => t.dueAt && isOverdue(t.dueAt, t.allDay, zone, now))
  const upcoming = list.filter((t) => !overdue.includes(t))
  return { overdue, upcoming }
}
