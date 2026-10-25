import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { reminders } from '../src/db/schema.js'
import { parseLocalDue, toLocalIso } from '../src/tasks/time.js'
import { createTestApp, hours, PHONE, ZONE } from './helpers.js'

type Ctx = Awaited<ReturnType<typeof createTestApp>>
let ctx: Ctx
let userId: string
const due = (iso: string) => parseLocalDue(iso, ZONE)!

beforeEach(async () => {
  ctx = await createTestApp()
  const { user } = await ctx.app.users.touch({ id: `${PHONE}@s.whatsapp.net`, phone: PHONE }, 'Taha')
  userId = user.id
})
afterEach(() => ctx.close())

describe('creating tasks', () => {
  it('numbers tasks per user and stores reminders', async () => {
    const a = await ctx.app.tasks.create(userId, {
      title: '  Submit   assignment ',
      due: due('2026-10-27T10:00'),
      reminders: [{ minutesBefore: 0 }],
    })
    const b = await ctx.app.tasks.create(userId, { title: 'Review portfolio', due: due('2026-10-30') })
    expect(a.number).toBe(1)
    expect(a.title).toBe('Submit assignment')
    expect(a.reminders).toHaveLength(1)
    expect(a.reminders[0]!.remindAt).toEqual(due('2026-10-27T10:00').at)
    expect(a.reminders[0]!.offsetMinutes).toBe(0)
    expect(b.number).toBe(2)
    expect(b.allDay).toBe(true)
  })

  it('rejects past due times and past reminders, without creating anything', async () => {
    await expect(ctx.app.tasks.create(userId, { title: 'Old', due: due('2026-10-25T10:00') })).rejects.toThrow('past')
    await expect(
      ctx.app.tasks.create(userId, { title: 'X', due: due('2026-10-27T10:00'), reminders: [{ at: due('2026-10-26T08:00').at }] }),
    ).rejects.toThrow('past')
    expect(await ctx.app.tasks.list(userId)).toHaveLength(0)
  })

  it('allows all-day tasks for today', async () => {
    await expect(ctx.app.tasks.create(userId, { title: 'Today thing', due: due('2026-10-26') })).resolves.toBeTruthy()
  })

  it('validates recurrence rules', async () => {
    await expect(ctx.app.tasks.create(userId, { title: 'X', recurrence: 'FREQ=DAILY' })).rejects.toThrow('first due date')
    await expect(
      ctx.app.tasks.create(userId, { title: 'X', due: due('2026-10-27T09:00'), recurrence: 'FREQ=MINUTELY' }),
    ).rejects.toThrow('daily, weekly')
  })
})

describe('listing and searching', () => {
  beforeEach(async () => {
    await ctx.app.tasks.create(userId, { title: 'Submit assignment', due: due('2026-10-27T10:00') })
    await ctx.app.tasks.create(userId, { title: 'Prepare project presentation', due: due('2026-10-29') })
    await ctx.app.tasks.create(userId, { title: 'Review portfolio', due: due('2026-11-05') })
    await ctx.app.tasks.create(userId, { title: 'Buy a new notebook' })
  })

  it('filters by local date range, undated tasks last', async () => {
    const week = await ctx.app.tasks.list(userId, {
      from: due('2026-10-26').at,
      to: parseLocalDue('2026-11-01T23:59', ZONE)!.at,
      includeUndated: true,
    })
    expect(week.map((t) => t.number)).toEqual([1, 2, 4])
  })

  it('finds tasks by words, case-insensitively', async () => {
    expect((await ctx.app.tasks.search(userId, 'ASSIGNMENT')).map((t) => t.number)).toEqual([1])
    expect((await ctx.app.tasks.search(userId, 'project presentation')).map((t) => t.number)).toEqual([2])
    expect(await ctx.app.tasks.search(userId, '%')).toEqual([])
  })

  it('lists overdue tasks', async () => {
    ctx.clock.set(new Date('2026-10-27T06:00:00Z')) // Tue 11:00
    expect((await ctx.app.tasks.list(userId, { overdueOnly: true })).map((t) => t.number)).toEqual([1])
  })
})

describe('updating', () => {
  it('moves reminders together with the due time', async () => {
    const task = await ctx.app.tasks.create(userId, {
      title: 'Presentation',
      due: due('2026-10-29T15:00'),
      reminders: [{ minutesBefore: 60 }],
    })
    const updated = await ctx.app.tasks.update(userId, task.number, { due: due('2026-10-30T15:00') })
    expect(toLocalIso(updated.reminders[0]!.remindAt, ZONE)).toBe('2026-10-30T14:00')
  })

  it('cancels reminders that would move into the past', async () => {
    const task = await ctx.app.tasks.create(userId, {
      title: 'Call',
      due: due('2026-10-26T20:00'),
      reminders: [{ minutesBefore: 600 }], // 10:00 today
    })
    const updated = await ctx.app.tasks.update(userId, task.number, { due: due('2026-10-26T18:00') })
    expect(updated.reminders).toHaveLength(0)
  })

  it('reports unknown tasks clearly', async () => {
    await expect(ctx.app.tasks.update(userId, 42, { title: 'x' })).rejects.toThrow("There's no task #42.")
  })
})

describe('completing', () => {
  it('marks done and cancels pending reminders', async () => {
    const task = await ctx.app.tasks.create(userId, {
      title: 'Submit assignment',
      due: due('2026-10-27T10:00'),
      reminders: [{ minutesBefore: 0 }],
    })
    const { task: done, nextDue } = await ctx.app.tasks.complete(userId, task.number, ZONE)
    expect(done.status).toBe('done')
    expect(nextDue).toBeNull()
    const [r] = await ctx.db.select().from(reminders).where(eq(reminders.taskId, task.id))
    expect(r!.status).toBe('cancelled')
    await expect(ctx.app.tasks.complete(userId, task.number, ZONE)).rejects.toThrow('already completed')
  })

  it('moves a recurring task to its next occurrence with the same reminders', async () => {
    const task = await ctx.app.tasks.create(userId, {
      title: 'Plan the week',
      due: due('2026-10-26T18:00'),
      recurrence: 'FREQ=WEEKLY;BYDAY=MO',
      reminders: [{ minutesBefore: 30 }],
    })
    const { task: next, nextDue } = await ctx.app.tasks.complete(userId, task.number, ZONE)
    expect(next.status).toBe('open')
    expect(toLocalIso(nextDue!, ZONE)).toBe('2026-11-02T18:00')
    const pending = await ctx.app.tasks.get(userId, task.number)
    expect(pending.reminders.map((r) => toLocalIso(r.remindAt, ZONE))).toEqual(['2026-11-02T17:30'])
  })

  it('advances missed recurring occurrences automatically', async () => {
    const task = await ctx.app.tasks.create(userId, {
      title: 'Take vitamins',
      due: due('2026-10-26T10:00'),
      recurrence: 'FREQ=DAILY',
      reminders: [{ minutesBefore: 0 }],
    })
    ctx.clock.advance(hours(9)) // 18:00, 8h after the occurrence
    const advanced = await ctx.app.tasks.advanceMissedRecurring(async () => ZONE, hours(6))
    expect(advanced).toBe(1)
    const after = await ctx.app.tasks.get(userId, task.number)
    expect(toLocalIso(after.dueAt!, ZONE)).toBe('2026-10-27T10:00')
    expect(after.reminders.map((r) => toLocalIso(r.remindAt, ZONE))).toEqual(['2026-10-27T10:00'])
  })
})

describe('undo and history', () => {
  it('undoes create, delete, complete and update — newest first', async () => {
    const t = await ctx.app.tasks.create(userId, {
      title: 'Submit assignment',
      due: due('2026-10-27T10:00'),
      reminders: [{ minutesBefore: 0 }],
    })
    await ctx.app.tasks.update(userId, t.number, { due: due('2026-10-28T10:00') })
    await ctx.app.tasks.complete(userId, t.number, ZONE)
    await ctx.app.tasks.delete(userId, [t.number])

    expect((await ctx.app.tasks.undoLast(userId)).description).toContain('Restored')
    expect((await ctx.app.tasks.get(userId, t.number)).status).toBe('done')

    expect((await ctx.app.tasks.undoLast(userId)).description).toContain('open again')
    let current = await ctx.app.tasks.get(userId, t.number)
    expect(current.status).toBe('open')
    expect(current.reminders).toHaveLength(1)

    await ctx.app.tasks.undoLast(userId) // the reschedule
    current = await ctx.app.tasks.get(userId, t.number)
    expect(toLocalIso(current.dueAt!, ZONE)).toBe('2026-10-27T10:00')
    expect(toLocalIso(current.reminders[0]!.remindAt, ZONE)).toBe('2026-10-27T10:00')

    expect((await ctx.app.tasks.undoLast(userId)).description).toContain('Removed')
    await expect(ctx.app.tasks.get(userId, t.number)).rejects.toThrow()
    await expect(ctx.app.tasks.undoLast(userId)).rejects.toThrow('nothing to undo')
  })

  it('undoes an added reminder', async () => {
    const t = await ctx.app.tasks.create(userId, { title: 'Call mom', due: due('2026-10-26T18:00') })
    await ctx.app.tasks.addReminder(userId, t.number, { minutesBefore: 15 })
    const result = await ctx.app.tasks.undoLast(userId)
    expect(result.description).toContain('Removed the reminder')
    expect((await ctx.app.tasks.get(userId, t.number)).reminders).toHaveLength(0)
  })

  it('records history for a period', async () => {
    const t = await ctx.app.tasks.create(userId, { title: 'Write report' })
    ctx.clock.advance(hours(1))
    await ctx.app.tasks.complete(userId, t.number, ZONE)
    const entries = await ctx.app.tasks.history(userId, due('2026-10-26').at, parseLocalDue('2026-10-26T23:59', ZONE)!.at)
    expect(entries.map((e) => e.event.type)).toEqual(['completed', 'created'])
  })
})
