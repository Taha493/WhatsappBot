import { and, asc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { reminders, tasks, users, type Reminder, type Task, type User } from '../db/schema.js'
import { TaskError } from './errors.js'
import type { Clock } from './time.js'

export const MAX_SEND_ATTEMPTS = 3
/** A reminder stuck in "sending" this long (e.g. crash mid-send) is picked up again. */
export const STALE_CLAIM_MS = 5 * 60_000

export type ReminderSpec = { at: Date } | { minutesBefore: number }

export type DueReminder = { reminder: Reminder; task: Task; user: User }

/** Reminder persistence and the claim/deliver state machine. Task-level rules live in TaskService. */
export class ReminderService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Resolves a spec against a task and inserts the reminder. `ex` may be a transaction. */
  async add(ex: Db, task: Task, spec: ReminderSpec): Promise<Reminder> {
    const now = this.clock()
    let remindAt: Date
    if ('at' in spec) {
      remindAt = spec.at
    } else {
      if (!task.dueAt) {
        throw new TaskError('invalid', `Task #${task.number} has no due time, so "before" reminders need one first.`)
      }
      remindAt = new Date(task.dueAt.getTime() - spec.minutesBefore * 60_000)
    }
    if (remindAt.getTime() <= now.getTime()) {
      throw new TaskError('invalid', 'That reminder time is already in the past.')
    }
    const offsetMinutes = task.dueAt
      ? Math.round((task.dueAt.getTime() - remindAt.getTime()) / 60_000)
      : null
    const [row] = await ex
      .insert(reminders)
      .values({ taskId: task.id, userId: task.userId, remindAt, offsetMinutes })
      .returning()
    return row!
  }

  scheduledForTask(ex: Db, taskId: string): Promise<Reminder[]> {
    return ex
      .select()
      .from(reminders)
      .where(and(eq(reminders.taskId, taskId), eq(reminders.status, 'scheduled')))
      .orderBy(asc(reminders.remindAt))
  }

  async scheduledForTasks(taskIds: string[]): Promise<Map<string, Reminder[]>> {
    const map = new Map<string, Reminder[]>()
    if (taskIds.length === 0) return map
    const rows = await this.db
      .select()
      .from(reminders)
      .where(and(inArray(reminders.taskId, taskIds), eq(reminders.status, 'scheduled')))
      .orderBy(asc(reminders.remindAt))
    for (const row of rows) map.set(row.taskId, [...(map.get(row.taskId) ?? []), row])
    return map
  }

  /** Cancels all scheduled reminders of a task; returns the cancelled ids. */
  async cancelForTask(ex: Db, taskId: string): Promise<string[]> {
    const rows = await ex
      .update(reminders)
      .set({ status: 'cancelled' })
      .where(and(eq(reminders.taskId, taskId), eq(reminders.status, 'scheduled')))
      .returning({ id: reminders.id })
    return rows.map((r) => r.id)
  }

  async cancelIds(ex: Db, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await ex
      .update(reminders)
      .set({ status: 'cancelled' })
      .where(and(inArray(reminders.id, ids), eq(reminders.status, 'scheduled')))
  }

  /** Re-schedules previously cancelled reminders that are still in the future. */
  async restore(ex: Db, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await ex
      .update(reminders)
      .set({ status: 'scheduled' })
      .where(
        and(
          inArray(reminders.id, ids),
          eq(reminders.status, 'cancelled'),
          sql`${reminders.remindAt} > ${this.clock()}`,
        ),
      )
  }

  /**
   * Moves a task's scheduled reminders by `deltaMs` (when its due time changes).
   * Reminders that would land in the past are cancelled instead.
   */
  async shiftForTask(ex: Db, taskId: string, deltaMs: number) {
    const now = this.clock().getTime()
    const shifted: string[] = []
    const cancelled: string[] = []
    for (const r of await this.scheduledForTask(ex, taskId)) {
      const next = new Date(r.remindAt.getTime() + deltaMs)
      if (next.getTime() <= now) {
        cancelled.push(r.id)
      } else {
        shifted.push(r.id)
        await ex.update(reminders).set({ remindAt: next }).where(eq(reminders.id, r.id))
      }
    }
    await this.cancelIds(ex, cancelled)
    return { shifted, cancelled }
  }

  async shiftIds(ex: Db, ids: string[], deltaMs: number): Promise<void> {
    if (ids.length === 0) return
    await ex
      .update(reminders)
      .set({ remindAt: sql`${reminders.remindAt} + make_interval(secs => ${deltaMs / 1000})` })
      .where(and(inArray(reminders.id, ids), eq(reminders.status, 'scheduled')))
  }

  /**
   * Atomically claims due reminders for delivery. Concurrent callers never get the same
   * reminder (FOR UPDATE SKIP LOCKED). Stale claims are retried, up to MAX_SEND_ATTEMPTS.
   */
  async claimDue(limit = 25): Promise<DueReminder[]> {
    const now = this.clock()
    const stale = new Date(now.getTime() - STALE_CLAIM_MS)
    const claimed = await this.db.transaction(async (tx) => {
      await tx
        .update(reminders)
        .set({ status: 'failed', lastError: 'Gave up after repeated interrupted sends' })
        .where(
          and(
            eq(reminders.status, 'sending'),
            lt(reminders.claimedAt, stale),
            sql`${reminders.attempts} >= ${MAX_SEND_ATTEMPTS}`,
          ),
        )
      const due = await tx
        .select({ id: reminders.id })
        .from(reminders)
        .where(
          or(
            and(eq(reminders.status, 'scheduled'), lte(reminders.remindAt, now)),
            and(eq(reminders.status, 'sending'), lt(reminders.claimedAt, stale)),
          ),
        )
        .orderBy(asc(reminders.remindAt))
        .limit(limit)
        .for('update', { skipLocked: true })
      if (due.length === 0) return []
      return tx
        .update(reminders)
        .set({ status: 'sending', claimedAt: now, attempts: sql`${reminders.attempts} + 1` })
        .where(
          inArray(
            reminders.id,
            due.map((d) => d.id),
          ),
        )
        .returning()
    })
    if (claimed.length === 0) return []

    const rows = await this.db
      .select({ task: tasks, user: users })
      .from(tasks)
      .innerJoin(users, eq(users.id, tasks.userId))
      .where(
        inArray(
          tasks.id,
          claimed.map((r) => r.taskId),
        ),
      )
    const byTask = new Map(rows.map((r) => [r.task.id, r]))
    return claimed
      .sort((a, b) => a.remindAt.getTime() - b.remindAt.getTime())
      .flatMap((reminder) => {
        const row = byTask.get(reminder.taskId)
        return row ? [{ reminder, task: row.task, user: row.user }] : []
      })
  }

  async markSent(id: string, waMessageId: string | null): Promise<void> {
    await this.db
      .update(reminders)
      .set({ status: 'sent', sentAt: this.clock(), waMessageId })
      .where(eq(reminders.id, id))
  }

  /** Puts the reminder back for another attempt, or marks it failed after MAX_SEND_ATTEMPTS. */
  async markFailed(reminder: Reminder, error: string): Promise<void> {
    const final = reminder.attempts >= MAX_SEND_ATTEMPTS
    await this.db
      .update(reminders)
      .set({ status: final ? 'failed' : 'scheduled', lastError: error.slice(0, 500), claimedAt: null })
      .where(eq(reminders.id, reminder.id))
  }

  async markCancelled(id: string): Promise<void> {
    await this.db.update(reminders).set({ status: 'cancelled' }).where(eq(reminders.id, id))
  }

  /** The reminder a message id belongs to (for quote-replies), if exactly one. */
  async findByMessageId(userId: string, waMessageId: string): Promise<DueReminder | null> {
    const rows = await this.db
      .select({ reminder: reminders, task: tasks, user: users })
      .from(reminders)
      .innerJoin(tasks, eq(tasks.id, reminders.taskId))
      .innerJoin(users, eq(users.id, reminders.userId))
      .where(and(eq(reminders.userId, userId), eq(reminders.waMessageId, waMessageId)))
    return rows.length === 1 ? rows[0]! : null
  }
}
