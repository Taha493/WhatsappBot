import { tool } from 'ai'
import { z } from 'zod'
import type { Reminder, Task, User } from '../db/schema.js'
import type { UserService } from '../core/users.js'
import type { ToolCallRecord } from './types.js'
import { TaskError } from '../tasks/errors.js'
import type { ReminderSpec } from '../tasks/reminders.js'
import type { TaskService, TaskWithReminders } from '../tasks/service.js'
import {
  describeRecurrence,
  formatDue,
  isValidTimezone,
  parseLocalDate,
  parseLocalDue,
  toLocalIso,
  type Clock,
  type ParsedDue,
} from '../tasks/time.js'
import { DateTime } from 'luxon'

export type ToolDeps = {
  tasks: TaskService
  users: UserService
  user: User
  zone: string
  clock: Clock
  /** Called before a tool runs and after it finishes (the agent tracks side effects with it). */
  onToolStart?: (name: ToolName) => void
  onToolResult?: (record: ToolCallRecord) => void
}

/** Tools that only read data; anything else changes the user's tasks or settings. */
export const READ_ONLY_TOOLS = new Set(['listTasks', 'searchTasks', 'getHistory'])

const localDateTime = z
  .string()
  .describe('Local time in the user\'s timezone: "YYYY-MM-DDTHH:mm", or "YYYY-MM-DD" for a whole day')
const localDate = z.string().describe('Local date "YYYY-MM-DD"')
const taskNumber = z.number().int().positive().describe('The task number shown as #N')
const priority = z.enum(['low', 'normal', 'high'])
const reminderInput = z.object({
  at: localDateTime.optional().describe('Exact local time for the reminder'),
  minutesBefore: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Minutes before the task is due (0 = at the due time)'),
})

export function buildTools(d: ToolDeps) {
  const { tasks, users, user, clock } = d
  let zone = d.zone

  const view = (t: Task & { reminders?: Reminder[] }) => ({
    number: t.number,
    title: t.title,
    notes: t.notes ?? undefined,
    due: t.dueAt ? toLocalIso(t.dueAt, zone, t.allDay) : null,
    dueText: t.dueAt ? formatDue(t.dueAt, t.allDay, zone, clock()) : null,
    priority: t.priority,
    status: t.status,
    repeats: t.recurrence ? describeRecurrence(t.recurrence) : undefined,
    reminders: t.reminders?.map((r) => toLocalIso(r.remindAt, zone)),
  })

  /** Runs a tool body; expected failures go back to the model as { ok: false, error }. */
  const run = async <T>(name: ToolName, fn: () => Promise<T>): Promise<T | { ok: false; error: string }> => {
    d.onToolStart?.(name)
    let output: T | { ok: false; error: string }
    try {
      output = await fn()
    } catch (err) {
      if (!(err instanceof TaskError)) throw err
      output = { ok: false, error: err.message }
    }
    return output
  }

  const parseDue = (value: string): ParsedDue => {
    const parsed = parseLocalDue(value, zone)
    if (!parsed) {
      throw new TaskError('invalid', `Couldn't read the date "${value}". Use YYYY-MM-DD or YYYY-MM-DDTHH:mm.`)
    }
    return parsed
  }

  const toSpec = (r: z.infer<typeof reminderInput>): ReminderSpec => {
    if (r.at) {
      const parsed = parseDue(r.at)
      // A date-only reminder fires at 09:00 local time that day.
      const at = parsed.allDay
        ? DateTime.fromJSDate(parsed.at, { zone }).set({ hour: 9 }).toJSDate()
        : parsed.at
      return { at }
    }
    if (r.minutesBefore !== undefined) return { minutesBefore: r.minutesBefore }
    throw new TaskError('invalid', 'A reminder needs either "at" or "minutesBefore".')
  }

  const range = (from?: string, to?: string) => {
    const start = from ? parseLocalDate(from, zone, 'start') : undefined
    const end = to ? parseLocalDate(to, zone, 'end') : undefined
    if (start === null || end === null) throw new TaskError('invalid', 'Dates must look like YYYY-MM-DD.')
    return { from: start, to: end }
  }

  const tools = {
    createTask: tool({
      description:
        'Create a task. Include reminders when the user asks to be reminded ("remind me…"). ' +
        'For "remind me to X at T" set due = T and a reminder with minutesBefore 0.',
      inputSchema: z.object({
        title: z.string().describe('Short task title, starting with a verb, without the date/time'),
        notes: z.string().optional(),
        due: localDateTime.optional(),
        priority: priority.optional(),
        recurrence: z
          .string()
          .optional()
          .describe('RRULE for repeating tasks, e.g. "FREQ=WEEKLY;BYDAY=MO" or "FREQ=DAILY". Needs a due.'),
        reminders: z.array(reminderInput).optional(),
      }),
      execute: (input) =>
        run('createTask', async () => {
          const created = await tasks.create(user.id, {
            title: input.title,
            notes: input.notes,
            due: input.due ? parseDue(input.due) : null,
            priority: input.priority,
            recurrence: input.recurrence,
            reminders: input.reminders?.map(toSpec),
          })
          return { ok: true, task: view(created) }
        }),
    }),

    updateTask: tool({
      description: 'Change a task: rename, reschedule, notes, priority or repeat rule. Reminders move with the due time.',
      inputSchema: z.object({
        taskNumber,
        title: z.string().optional(),
        notes: z.string().optional(),
        due: localDateTime.optional(),
        clearDue: z.boolean().optional().describe('Remove the due date'),
        priority: priority.optional(),
        recurrence: z.string().optional().describe('New RRULE, or "none" to stop repeating'),
      }),
      execute: (input) =>
        run('updateTask', async () => {
          const updated = await tasks.update(user.id, input.taskNumber, {
            title: input.title,
            notes: input.notes,
            due: input.clearDue ? null : input.due ? parseDue(input.due) : undefined,
            priority: input.priority,
            recurrence: input.recurrence === undefined ? undefined : input.recurrence === 'none' ? null : input.recurrence,
          })
          return { ok: true, task: view(updated) }
        }),
    }),

    completeTask: tool({
      description: 'Mark a task as done. Repeating tasks move on to their next occurrence.',
      inputSchema: z.object({ taskNumber }),
      execute: ({ taskNumber }) =>
        run('completeTask', async () => {
          const { task, nextDue } = await tasks.complete(user.id, taskNumber, zone)
          return {
            ok: true,
            task: view(task),
            nextOccurrence: nextDue ? formatDue(nextDue, task.allDay, zone, clock()) : undefined,
          }
        }),
    }),

    reopenTask: tool({
      description: 'Mark a completed task as not done again.',
      inputSchema: z.object({ taskNumber }),
      execute: ({ taskNumber }) => run('reopenTask', async () => ({ ok: true, task: view(await tasks.reopen(user.id, taskNumber)) })),
    }),

    deleteTasks: tool({
      description:
        'Delete one or more tasks (they can be restored with undo). ' +
        'For more than 3 tasks, ask the user to confirm first and only then call with confirmed: true.',
      inputSchema: z.object({
        taskNumbers: z.array(taskNumber).min(1),
        confirmed: z.boolean().optional(),
      }),
      execute: ({ taskNumbers, confirmed }) =>
        run('deleteTasks', async () => {
          if (taskNumbers.length > 3 && !confirmed) {
            return { ok: false, error: 'Ask the user to confirm deleting these tasks first.' }
          }
          const deleted = await tasks.delete(user.id, taskNumbers)
          return { ok: true, deleted: deleted.map((t) => ({ number: t.number, title: t.title })) }
        }),
    }),

    listTasks: tool({
      description:
        'List tasks. Use a date range for questions like "today" or "this week". ' +
        'Undated tasks are included with a range unless includeUndated is false.',
      inputSchema: z.object({
        from: localDate.optional(),
        to: localDate.optional(),
        status: z.enum(['open', 'done', 'all']).optional().describe('Default: open'),
        overdueOnly: z.boolean().optional(),
        includeUndated: z.boolean().optional(),
      }),
      execute: (input) =>
        run('listTasks', async () => {
          const { from, to } = range(input.from, input.to)
          const list: TaskWithReminders[] = await tasks.list(user.id, {
            status: input.status,
            from,
            to,
            overdueOnly: input.overdueOnly,
            includeUndated: input.includeUndated ?? true,
          })
          return { ok: true, count: list.length, tasks: list.map(view) }
        }),
    }),

    searchTasks: tool({
      description: 'Find tasks by words in their title or notes, e.g. to find "the assignment" when it isn\'t in the open-task list.',
      inputSchema: z.object({
        query: z.string(),
        includeCompleted: z.boolean().optional(),
      }),
      execute: ({ query, includeCompleted }) =>
        run('searchTasks', async () => {
          const found = await tasks.search(user.id, query, includeCompleted ?? false)
          return { ok: true, tasks: found.map(view) }
        }),
    }),

    addReminder: tool({
      description: 'Add a reminder to an existing task, at an exact time or some minutes before it is due.',
      inputSchema: z.object({ taskNumber }).extend(reminderInput.shape),
      execute: ({ taskNumber, ...spec }) =>
        run('addReminder', async () => {
          const { task, reminder } = await tasks.addReminder(user.id, taskNumber, toSpec(spec))
          return {
            ok: true,
            task: task.title,
            remindAt: formatDue(reminder.remindAt, false, zone, clock()),
          }
        }),
    }),

    cancelReminders: tool({
      description: 'Cancel all upcoming reminders of a task (the task itself stays).',
      inputSchema: z.object({ taskNumber }),
      execute: ({ taskNumber }) =>
        run('cancelReminders', async () => {
          const { task, cancelled } = await tasks.cancelReminders(user.id, taskNumber)
          return { ok: true, task: task.title, cancelled }
        }),
    }),

    getHistory: tool({
      description: 'What happened to tasks in a period: created, completed, deleted… e.g. "what did I finish last week?"',
      inputSchema: z.object({ from: localDate, to: localDate }),
      execute: (input) =>
        run('getHistory', async () => {
          const { from, to } = range(input.from, input.to)
          const entries = await tasks.history(user.id, from!, to!)
          return {
            ok: true,
            events: entries.map((e) => ({
              type: e.event.type,
              task: `#${e.number} ${e.title}`,
              when: formatDue(e.event.createdAt, false, zone, clock()),
            })),
          }
        }),
    }),

    undoLastAction: tool({
      description: 'Undo the most recent change (create, edit, complete, delete or reminder change).',
      inputSchema: z.object({}),
      execute: () =>
        run('undoLastAction', async () => {
          const result = await tasks.undoLast(user.id)
          return { ok: true, undone: result.description }
        }),
    }),

    updatePreferences: tool({
      description:
        'Change settings: timezone (IANA name, e.g. "Europe/London" — map the user\'s city to it), ' +
        'and the daily morning summary (on/off and time).',
      inputSchema: z.object({
        timezone: z.string().optional(),
        dailySummary: z.boolean().optional(),
        dailySummaryTime: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('"HH:MM" 24-hour local time'),
      }),
      execute: (input) =>
        run('updatePreferences', async () => {
          if (input.timezone && !isValidTimezone(input.timezone)) {
            return { ok: false, error: `"${input.timezone}" is not a valid IANA timezone.` }
          }
          const updated = await users.updatePreferences(user.id, {
            timezone: input.timezone,
            digestEnabled: input.dailySummary,
            digestTime: input.dailySummaryTime,
          })
          if (updated.timezone) zone = updated.timezone
          return {
            ok: true,
            timezone: updated.timezone,
            localTimeNow: DateTime.fromJSDate(clock(), { zone }).toFormat('h:mm a'),
            dailySummary: updated.digestEnabled ? updated.digestTime?.slice(0, 5) : 'off',
          }
        }),
    }),
  }

  // Report every finished call (with its input) to the agent.
  for (const [name, t] of Object.entries(tools) as Array<[ToolName, { execute?: (...args: never[]) => unknown }]>) {
    const execute = t.execute!
    t.execute = (async (input: unknown, options: unknown) => {
      const output = await (execute as (i: unknown, o: unknown) => Promise<unknown>)(input, options)
      d.onToolResult?.({ name, input, output })
      return output
    }) as typeof execute
  }
  return tools
}

export type AssistantTools = ReturnType<typeof buildTools>
export type ToolName =
  | 'createTask'
  | 'updateTask'
  | 'completeTask'
  | 'reopenTask'
  | 'deleteTasks'
  | 'listTasks'
  | 'searchTasks'
  | 'addReminder'
  | 'cancelReminders'
  | 'getHistory'
  | 'undoLastAction'
  | 'updatePreferences'
