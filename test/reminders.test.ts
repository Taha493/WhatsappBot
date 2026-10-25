import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { reminders } from '../src/db/schema.js'
import { MAX_SEND_ATTEMPTS, STALE_CLAIM_MS } from '../src/tasks/reminders.js'
import { parseLocalDue } from '../src/tasks/time.js'
import { createTestApp, hours, minutes, PHONE, ZONE } from './helpers.js'

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

async function reminderAt(iso: string, title = 'Submit assignment') {
  return ctx.app.tasks.create(userId, { title, due: due(iso), reminders: [{ minutesBefore: 0 }] })
}

describe('claiming', () => {
  it('claims only due reminders, and never the same one twice', async () => {
    await reminderAt('2026-10-26T10:00')
    await reminderAt('2026-10-26T12:00', 'Later')
    ctx.clock.advance(hours(1)) // 10:00

    const [first, second] = await Promise.all([ctx.app.reminders.claimDue(), ctx.app.reminders.claimDue()])
    const claimed = [...first, ...second]
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.task.title).toBe('Submit assignment')
    expect(await ctx.app.reminders.claimDue()).toHaveLength(0)
  })

  it('retries stale claims, then gives up after the max attempts', async () => {
    const task = await reminderAt('2026-10-26T10:00')
    ctx.clock.advance(hours(1))
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) {
      expect(await ctx.app.reminders.claimDue()).toHaveLength(1)
      ctx.clock.advance(STALE_CLAIM_MS + 1000) // the process "crashed" mid-send
    }
    expect(await ctx.app.reminders.claimDue()).toHaveLength(0)
    const [row] = await ctx.db.select().from(reminders).where(eq(reminders.taskId, task.id))
    expect(row!.status).toBe('failed')
  })
})

describe('delivery', () => {
  it('sends a due reminder once and records its message id', async () => {
    await reminderAt('2026-10-26T10:00')
    ctx.clock.advance(hours(1))
    await ctx.app.scheduler.tick()
    await ctx.app.scheduler.tick()

    expect(ctx.channel.sent).toHaveLength(1)
    expect(ctx.channel.last().text).toContain('⏰ *Reminder:* Submit assignment')
    expect(ctx.channel.last().text).toContain('Reply to this message')
    const [row] = await ctx.db.select().from(reminders)
    expect(row!.status).toBe('sent')
    expect(row!.waMessageId).toBe(ctx.channel.last().id)
  })

  it('does not send while disconnected, and catches up afterwards', async () => {
    await reminderAt('2026-10-26T10:00')
    ctx.clock.advance(hours(1))
    ctx.channel.state = 'connecting'
    await ctx.app.scheduler.tick()
    expect(ctx.channel.sent).toHaveLength(0)

    ctx.channel.state = 'open'
    ctx.clock.advance(minutes(30))
    await ctx.app.scheduler.tick()
    expect(ctx.channel.last().text).toContain('Sent late')
  })

  it('combines reminders missed during long downtime into one message', async () => {
    await reminderAt('2026-10-26T10:00', 'First')
    await reminderAt('2026-10-26T11:00', 'Second')
    ctx.clock.advance(hours(6))
    await ctx.app.scheduler.tick()
    expect(ctx.channel.sent).toHaveLength(1)
    expect(ctx.channel.last().text).toContain('missed these reminders')
    expect(ctx.channel.last().text).toContain('First')
    expect(ctx.channel.last().text).toContain('Second')
  })

  it('puts failed sends back for a retry', async () => {
    await reminderAt('2026-10-26T10:00')
    ctx.clock.advance(hours(1))
    ctx.channel.failSends = true
    await ctx.app.scheduler.tick()
    let [row] = await ctx.db.select().from(reminders)
    expect(row!.status).toBe('scheduled')
    expect(row!.attempts).toBe(1)

    ctx.channel.failSends = false
    await ctx.app.scheduler.tick()
    ;[row] = await ctx.db.select().from(reminders)
    expect(row!.status).toBe('sent')
  })

  it('skips reminders of tasks that are no longer open', async () => {
    const task = await reminderAt('2026-10-26T10:00')
    await ctx.db.update(reminders).set({ status: 'scheduled' }).where(eq(reminders.taskId, task.id))
    await ctx.app.tasks.delete(userId, [task.number])
    await ctx.db.update(reminders).set({ status: 'scheduled' }).where(eq(reminders.taskId, task.id))
    ctx.clock.advance(hours(1))
    await ctx.app.scheduler.tick()
    expect(ctx.channel.sent).toHaveLength(0)
  })
})

describe('quick actions on a reminder', () => {
  async function deliverReminder() {
    await reminderAt('2026-10-26T10:00')
    ctx.clock.advance(hours(1))
    await ctx.app.scheduler.tick()
    return ctx.channel.last().id
  }

  it('"done" completes the task without the LLM', async () => {
    const reminderMessage = await deliverReminder()
    await ctx.app.users.markOnboarded(userId)
    const msg = await ctx.channel.receive({ text: 'done', quotedId: reminderMessage })
    expect(ctx.channel.last().text).toContain('✅ Marked *Submit assignment* as done')
    expect(ctx.channel.reactions).toEqual([{ messageId: msg.id, emoji: '✅' }])
    expect(ctx.assistant.calls).toHaveLength(0)
  })

  it('"snooze 30m" schedules a new reminder that is then delivered', async () => {
    const reminderMessage = await deliverReminder()
    await ctx.channel.receive({ text: 'snooze 30m', quotedId: reminderMessage })
    expect(ctx.channel.last().text).toContain("I'll remind you about *Submit assignment* today, 10:30 AM")
    ctx.channel.clear()
    ctx.clock.advance(minutes(31))
    await ctx.app.scheduler.tick()
    expect(ctx.channel.last().text).toContain('⏰ *Reminder:* Submit assignment')
  })

  it('"tomorrow" re-reminds at the same time tomorrow', async () => {
    const reminderMessage = await deliverReminder()
    await ctx.channel.receive({ text: 'tomorrow', quotedId: reminderMessage })
    expect(ctx.channel.last().text).toContain('tomorrow, 10:00 AM')
  })

  it('passes other replies to the assistant with the reminder as context', async () => {
    const reminderMessage = await deliverReminder()
    await ctx.channel.receive({ text: 'move it to Friday', quotedId: reminderMessage })
    const calls = ctx.assistant.calls
    expect(calls.at(-1)!.text).toBe('[Replying to the reminder for task #1 "Submit assignment"] move it to Friday')
  })
})
