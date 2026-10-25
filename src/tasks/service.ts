import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import {
  reminders as remindersTable,
  taskEvents,
  tasks,
  users,
  type Reminder,
  type Task,
  type TaskEvent,
  type TaskEventMeta,
  type TaskSnapshot,
} from '../db/schema.js'
import { TaskError } from './errors.js'
import type { ReminderService, ReminderSpec } from './reminders.js'
import { nextOccurrence, normalizeRecurrence, type Clock, type ParsedDue } from './time.js'

export type Priority = 'low' | 'normal' | 'high'

export type TaskInput = {
  title: string
  notes?: string | null
  due?: ParsedDue | null
  priority?: Priority
  recurrence?: string | null
  reminders?: ReminderSpec[]
}

/** `undefined` = leave unchanged, `null` = clear. */
export type TaskPatch = {
  title?: string
  notes?: string | null
  due?: ParsedDue | null
  priority?: Priority
  recurrence?: string | null
}

export type TaskWithReminders = Task & { reminders: Reminder[] }

export type ListFilter = {
  status?: 'open' | 'done' | 'all'
  from?: Date
  to?: Date
  /** With a date range, also include tasks without a due date. */
  includeUndated?: boolean
  overdueOnly?: boolean
  limit?: number
}

export type HistoryEntry = { event: TaskEvent; title: string; number: number }
export type UndoResult = { type: TaskEvent['type']; task: Task; description: string }

const MAX_TITLE = 200
/** Small grace so "now" isn't rejected as past because of processing delay. */
const PAST_GRACE_MS = 60_000

function snapshot(t: Task): TaskSnapshot {
  return {
    title: t.title,
    notes: t.notes,
    dueAt: t.dueAt?.toISOString() ?? null,
    allDay: t.allDay,
    priority: t.priority,
    status: t.status,
    recurrence: t.recurrence,
  }
}

function cleanTitle(title: string): string {
  const value = title.trim().replace(/\s+/g, ' ')
  if (!value) throw new TaskError('invalid', 'A task needs a title.')
  if (value.length > MAX_TITLE) throw new TaskError('invalid', `Task titles can be at most ${MAX_TITLE} characters.`)
  return value
}

/** Task rules: numbering, validation, history (task_events) and undo. */
export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly reminders: ReminderService,
    private readonly clock: Clock,
  ) {}

  // ── Queries ───────────────────────────────────────────────────────────

  async get(userId: string, number: number): Promise<TaskWithReminders> {
    const task = await this.find(this.db, userId, number)
    return { ...task, reminders: await this.reminders.scheduledForTask(this.db, task.id) }
  }

  async list(userId: string, filter: ListFilter = {}): Promise<TaskWithReminders[]> {
    const conditions: SQL[] = [eq(tasks.userId, userId)]
    const status = filter.overdueOnly ? 'open' : (filter.status ?? 'open')
    conditions.push(status === 'all' ? ne(tasks.status, 'deleted') : eq(tasks.status, status))

    const range: SQL[] = []
    if (filter.from) range.push(gte(tasks.dueAt, filter.from))
    if (filter.to) range.push(lte(tasks.dueAt, filter.to))
    if (filter.overdueOnly) range.push(lt(tasks.dueAt, this.clock()))
    if (range.length > 0) {
      const inRange = and(...range)!
      conditions.push(filter.includeUndated && !filter.overdueOnly ? or(isNull(tasks.dueAt), inRange)! : inRange)
    }

    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(sql`${tasks.dueAt} asc nulls last`, asc(tasks.number))
      .limit(filter.limit ?? 50)
    return this.attachReminders(rows)
  }

  async search(userId: string, query: string, includeDone = false): Promise<TaskWithReminders[]> {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[%_\\]/g, ''))
      .filter((w) => w.length >= 2)
      .slice(0, 5)
    if (words.length === 0) return []
    const rows = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          includeDone ? ne(tasks.status, 'deleted') : eq(tasks.status, 'open'),
          ...words.map((w) => or(ilike(tasks.title, `%${w}%`), ilike(tasks.notes, `%${w}%`))!),
        ),
      )
      .orderBy(sql`${tasks.dueAt} asc nulls last`)
      .limit(10)
    return this.attachReminders(rows)
  }

  async history(userId: string, from: Date, to: Date): Promise<HistoryEntry[]> {
    const rows = await this.db
      .select({ event: taskEvents, title: tasks.title, number: tasks.number })
      .from(taskEvents)
      .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
      .where(
        and(
          eq(taskEvents.userId, userId),
          gte(taskEvents.createdAt, from),
          lte(taskEvents.createdAt, to),
          isNull(taskEvents.undoneAt),
        ),
      )
      .orderBy(desc(taskEvents.seq))
      .limit(50)
    return rows
  }

  // ── Commands ──────────────────────────────────────────────────────────

  async create(userId: string, input: TaskInput): Promise<TaskWithReminders> {
    const title = cleanTitle(input.title)
    const due = input.due ?? null
    this.assertNotPast(due)
    const recurrence = this.checkRecurrence(input.recurrence ?? null, due)

    return this.db.transaction(async (tx) => {
      const [counter] = await tx
        .update(users)
        .set({ nextTaskNumber: sql`${users.nextTaskNumber} + 1` })
        .where(eq(users.id, userId))
        .returning({ next: users.nextTaskNumber })
      if (!counter) throw new TaskError('not_found', 'User not found.')

      const [task] = await tx
        .insert(tasks)
        .values({
          userId,
          number: counter.next - 1,
          title,
          notes: input.notes?.trim() || null,
          dueAt: due?.at ?? null,
          allDay: due?.allDay ?? false,
          priority: input.priority ?? 'normal',
          recurrence,
        })
        .returning()
      const created: Reminder[] = []
      for (const spec of input.reminders ?? []) created.push(await this.reminders.add(tx, task!, spec))

      await this.logEvent(tx, task!, 'created', null, task!, {
        createdReminderIds: created.map((r) => r.id),
      })
      return { ...task!, reminders: created }
    })
  }

  async update(userId: string, number: number, patch: TaskPatch): Promise<TaskWithReminders> {
    return this.db.transaction(async (tx) => {
      const task = await this.find(tx, userId, number)
      const changes: Partial<typeof tasks.$inferInsert> = { updatedAt: this.clock() }
      if (patch.title !== undefined) changes.title = cleanTitle(patch.title)
      if (patch.notes !== undefined) changes.notes = patch.notes?.trim() || null
      if (patch.priority !== undefined) changes.priority = patch.priority
      if (patch.due !== undefined) {
        this.assertNotPast(patch.due)
        changes.dueAt = patch.due?.at ?? null
        changes.allDay = patch.due?.allDay ?? false
      }
      const finalDue =
        patch.due !== undefined ? patch.due : task.dueAt ? { at: task.dueAt, allDay: task.allDay } : null
      const finalRecurrence = patch.recurrence !== undefined ? patch.recurrence : task.recurrence
      changes.recurrence = this.checkRecurrence(finalRecurrence, finalDue)

      const [updated] = await tx.update(tasks).set(changes).where(eq(tasks.id, task.id)).returning()

      const meta: TaskEventMeta = {}
      if (task.dueAt && updated!.dueAt && task.dueAt.getTime() !== updated!.dueAt.getTime()) {
        const shiftMs = updated!.dueAt.getTime() - task.dueAt.getTime()
        const { shifted, cancelled } = await this.reminders.shiftForTask(tx, task.id, shiftMs)
        Object.assign(meta, { shiftMs, shiftedReminderIds: shifted, cancelledReminderIds: cancelled })
      }
      await this.logEvent(tx, updated!, 'updated', task, updated!, meta)
      return { ...updated!, reminders: await this.reminders.scheduledForTask(tx, task.id) }
    })
  }

  /**
   * Marks a task done. A recurring task instead moves on to its next occurrence
   * (with the same reminder offsets) and stays open.
   */
  async complete(userId: string, number: number, zone: string): Promise<{ task: Task; nextDue: Date | null }> {
    return this.db.transaction(async (tx) => {
      const task = await this.find(tx, userId, number)
      if (task.status === 'done') throw new TaskError('conflict', `Task #${number} is already completed.`)

      if (task.recurrence && task.dueAt) {
        const rolled = await this.rollForward(tx, task, zone)
        if (rolled) {
          await this.logEvent(tx, rolled.task, 'completed', task, rolled.task, {
            occurrenceDueAt: task.dueAt.toISOString(),
            cancelledReminderIds: rolled.cancelled,
            createdReminderIds: rolled.created,
          })
          return { task: rolled.task, nextDue: rolled.task.dueAt }
        }
      }

      const cancelled = await this.reminders.cancelForTask(tx, task.id)
      const [updated] = await tx
        .update(tasks)
        .set({ status: 'done', completedAt: this.clock(), updatedAt: this.clock() })
        .where(eq(tasks.id, task.id))
        .returning()
      await this.logEvent(tx, updated!, 'completed', task, updated!, { cancelledReminderIds: cancelled })
      return { task: updated!, nextDue: null }
    })
  }

  async reopen(userId: string, number: number): Promise<Task> {
    return this.db.transaction(async (tx) => {
      const task = await this.find(tx, userId, number)
      if (task.status === 'open') throw new TaskError('conflict', `Task #${number} is already open.`)
      const [updated] = await tx
        .update(tasks)
        .set({ status: 'open', completedAt: null, updatedAt: this.clock() })
        .where(eq(tasks.id, task.id))
        .returning()
      await this.logEvent(tx, updated!, 'reopened', task, updated!, {})
      return updated!
    })
  }

  /** Soft-deletes tasks (undo restores them). */
  async delete(userId: string, numbers: number[]): Promise<Task[]> {
    return this.db.transaction(async (tx) => {
      const deleted: Task[] = []
      for (const number of [...new Set(numbers)]) {
        const task = await this.find(tx, userId, number)
        const cancelled = await this.reminders.cancelForTask(tx, task.id)
        const [updated] = await tx
          .update(tasks)
          .set({ status: 'deleted', deletedAt: this.clock(), updatedAt: this.clock() })
          .where(eq(tasks.id, task.id))
          .returning()
        await this.logEvent(tx, updated!, 'deleted', task, updated!, { cancelledReminderIds: cancelled })
        deleted.push(updated!)
      }
      return deleted
    })
  }

  async addReminder(userId: string, number: number, spec: ReminderSpec): Promise<{ task: Task; reminder: Reminder }> {
    return this.db.transaction(async (tx) => {
      const task = await this.find(tx, userId, number)
      if (task.status !== 'open') throw new TaskError('conflict', `Task #${number} is already completed.`)
      const reminder = await this.reminders.add(tx, task, spec)
      await this.logEvent(tx, task, 'updated', task, task, { createdReminderIds: [reminder.id] })
      return { task, reminder }
    })
  }

  async cancelReminders(userId: string, number: number): Promise<{ task: Task; cancelled: number }> {
    return this.db.transaction(async (tx) => {
      const task = await this.find(tx, userId, number)
      const cancelled = await this.reminders.cancelForTask(tx, task.id)
      if (cancelled.length > 0) {
        await this.logEvent(tx, task, 'updated', task, task, { cancelledReminderIds: cancelled })
      }
      return { task, cancelled: cancelled.length }
    })
  }

  /** Reverts the user's most recent change that hasn't been undone yet. */
  async undoLast(userId: string): Promise<UndoResult> {
    return this.db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(taskEvents)
        .where(and(eq(taskEvents.userId, userId), isNull(taskEvents.undoneAt)))
        .orderBy(desc(taskEvents.seq))
        .limit(1)
      if (!event) throw new TaskError('not_found', 'There is nothing to undo.')
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, event.taskId))
      if (!task) throw new TaskError('not_found', 'There is nothing to undo.')

      const meta = event.meta ?? {}
      const now = this.clock()
      let description: string
      const label = `"${task.title}" (#${task.number})`

      switch (event.type) {
        case 'created':
          await this.reminders.cancelForTask(tx, task.id)
          await tx.update(tasks).set({ status: 'deleted', deletedAt: now, updatedAt: now }).where(eq(tasks.id, task.id))
          description = `Removed ${label} again.`
          break
        case 'deleted':
          await tx
            .update(tasks)
            .set({ status: event.before?.status ?? 'open', deletedAt: null, updatedAt: now })
            .where(eq(tasks.id, task.id))
          await this.reminders.restore(tx, meta.cancelledReminderIds ?? [])
          description = `Restored ${label}.`
          break
        case 'completed':
          await tx
            .update(tasks)
            .set({ ...this.fromSnapshot(event.before!), completedAt: null, updatedAt: now })
            .where(eq(tasks.id, task.id))
          await this.reminders.cancelIds(tx, meta.createdReminderIds ?? [])
          await this.reminders.restore(tx, meta.cancelledReminderIds ?? [])
          description = `${label} is open again.`
          break
        case 'reopened':
          await tx.update(tasks).set({ status: 'done', completedAt: now, updatedAt: now }).where(eq(tasks.id, task.id))
          description = `${label} is marked as completed again.`
          break
        case 'updated':
        case 'restored':
          if (event.before) {
            await tx
              .update(tasks)
              .set({ ...this.fromSnapshot(event.before), updatedAt: now })
              .where(eq(tasks.id, task.id))
          }
          await this.reminders.shiftIds(tx, meta.shiftedReminderIds ?? [], -(meta.shiftMs ?? 0))
          await this.reminders.restore(tx, meta.cancelledReminderIds ?? [])
          await this.reminders.cancelIds(tx, meta.createdReminderIds ?? [])
          description =
            meta.createdReminderIds?.length && !meta.shiftMs
              ? `Removed the reminder I just set for ${label}.`
              : `Reverted the last change to ${label}.`
          break
      }

      await tx.update(taskEvents).set({ undoneAt: now }).where(eq(taskEvents.id, event.id))
      const [after] = await tx.select().from(tasks).where(eq(tasks.id, task.id))
      return { type: event.type, task: after!, description }
    })
  }

  /**
   * Recurring tasks whose occurrence passed `graceMs` ago without being completed move
   * on to the next occurrence (so daily/weekly reminders keep coming). Returns the count.
   */
  async advanceMissedRecurring(zoneFor: (userId: string) => Promise<string>, graceMs: number): Promise<number> {
    const cutoff = new Date(this.clock().getTime() - graceMs)
    const due = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.status, 'open'), sql`${tasks.recurrence} is not null`, lt(tasks.dueAt, cutoff)))
      .limit(50)
    let advanced = 0
    for (const task of due) {
      const zone = await zoneFor(task.userId)
      await this.db.transaction(async (tx) => {
        const rolled = await this.rollForward(tx, task, zone)
        if (rolled) advanced++
        else {
          // Series finished: close the task quietly.
          await tx.update(tasks).set({ recurrence: null, updatedAt: this.clock() }).where(eq(tasks.id, task.id))
        }
      })
    }
    return advanced
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async find(ex: Db, userId: string, number: number): Promise<Task> {
    const [task] = await ex
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.number, number), ne(tasks.status, 'deleted')))
    if (!task) throw new TaskError('not_found', `There's no task #${number}.`)
    return task
  }

  private async attachReminders(rows: Task[]): Promise<TaskWithReminders[]> {
    const map = await this.reminders.scheduledForTasks(rows.map((t) => t.id))
    return rows.map((t) => ({ ...t, reminders: map.get(t.id) ?? [] }))
  }

  private assertNotPast(due: ParsedDue | null | undefined) {
    if (!due || due.allDay) return
    if (due.at.getTime() < this.clock().getTime() - PAST_GRACE_MS) {
      throw new TaskError('invalid', 'That due time is already in the past.')
    }
  }

  private checkRecurrence(rule: string | null, due: ParsedDue | null): string | null {
    if (!rule) return null
    const normalized = normalizeRecurrence(rule)
    if (!normalized) {
      throw new TaskError('invalid', 'Repeats must be daily, weekly, monthly or yearly (RRULE like FREQ=WEEKLY;BYDAY=MO).')
    }
    if (!due) throw new TaskError('invalid', 'A repeating task needs a first due date.')
    return normalized
  }

  private fromSnapshot(s: TaskSnapshot): Partial<typeof tasks.$inferInsert> {
    return {
      title: s.title,
      notes: s.notes,
      dueAt: s.dueAt ? new Date(s.dueAt) : null,
      allDay: s.allDay,
      priority: s.priority,
      status: s.status,
      recurrence: s.recurrence,
    }
  }

  /** Moves a recurring task to its next occurrence and recreates its reminders. */
  private async rollForward(tx: Db, task: Task, zone: string) {
    if (!task.recurrence || !task.dueAt) return null
    const now = this.clock()
    const after = new Date(Math.max(now.getTime(), task.dueAt.getTime()))
    const next = nextOccurrence(task.recurrence, task.dueAt, zone, after)
    if (!next) return null

    // Offsets of this occurrence's reminders (sent or pending), reused for the next one.
    const dueMs = task.dueAt.getTime()
    const occurrenceReminders = (
      await tx
        .select()
        .from(remindersTable)
        .where(and(eq(remindersTable.taskId, task.id), inArray(remindersTable.status, ['scheduled', 'sending', 'sent'])))
    ).filter((r) => r.offsetMinutes !== null && r.remindAt.getTime() + r.offsetMinutes * 60_000 === dueMs)
    const offsets = [...new Set(occurrenceReminders.map((r) => r.offsetMinutes!))]

    const cancelled = await this.reminders.cancelForTask(tx, task.id)
    const [updated] = await tx
      .update(tasks)
      .set({ dueAt: next, updatedAt: now })
      .where(eq(tasks.id, task.id))
      .returning()
    const created: string[] = []
    for (const minutesBefore of offsets) {
      if (next.getTime() - minutesBefore * 60_000 > now.getTime()) {
        created.push((await this.reminders.add(tx, updated!, { minutesBefore })).id)
      }
    }
    return { task: updated!, cancelled, created }
  }

  private async logEvent(
    ex: Db,
    task: Task,
    type: TaskEvent['type'],
    before: Task | null,
    after: Task,
    meta: TaskEventMeta,
  ) {
    await ex.insert(taskEvents).values({
      taskId: task.id,
      userId: task.userId,
      type,
      before: before ? snapshot(before) : null,
      after: snapshot(after),
      meta,
      createdAt: this.clock(),
    })
  }
}
