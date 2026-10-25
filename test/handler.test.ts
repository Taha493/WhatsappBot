import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { messages, users } from '../src/db/schema.js'
import { AssistantUnavailableError } from '../src/ai/types.js'
import { parseLocalDue } from '../src/tasks/time.js'
import { createTestApp, FakeAssistant, PHONE, ZONE } from './helpers.js'

type Ctx = Awaited<ReturnType<typeof createTestApp>>
let ctx: Ctx
afterEach(() => ctx?.close())

describe('first contact', () => {
  it('welcomes a new user with their guessed timezone and stops at a greeting', async () => {
    ctx = await createTestApp()
    await ctx.channel.receive({ text: 'Hi' })
    expect(ctx.channel.sent).toHaveLength(1)
    expect(ctx.channel.last().text).toContain("I'm Remi")
    expect(ctx.channel.last().text).toContain('*Asia/Karachi*')
    const [user] = await ctx.db.select().from(users)
    expect(user!.timezone).toBe('Asia/Karachi')
    expect(user!.name).toBe('Taha')
  })

  it('welcomes and then handles a real first request', async () => {
    const assistant = new FakeAssistant(() => ({ text: "Done! I'll remind you tomorrow at 10:00 AM.", toolCalls: [] }))
    ctx = await createTestApp({ assistant })
    await ctx.channel.receive({ text: 'Remind me to submit my assignment tomorrow at 10 AM' })
    expect(ctx.channel.sent.map((s) => s.text)).toEqual([
      expect.stringContaining("I'm Remi"),
      "Done! I'll remind you tomorrow at 10:00 AM.",
    ])
  })

  it('asks for the city when the timezone cannot be guessed', async () => {
    ctx = await createTestApp()
    await ctx.channel.receive({ text: 'hello', from: { id: '12025550123@s.whatsapp.net', phone: '12025550123' } })
    expect(ctx.channel.last().text).toContain('Which city are you in?')
  })
})

describe('message handling', () => {
  it('ignores duplicate deliveries of the same message', async () => {
    const assistant = new FakeAssistant()
    ctx = await createTestApp({ assistant })
    await ctx.channel.receive({ id: 'abc', text: 'hi' })
    await ctx.channel.receive({ id: 'abc', text: 'hi' })
    await ctx.channel.receive({ id: 'def', text: 'what do I have today?' })
    await ctx.channel.receive({ id: 'def', text: 'what do I have today?' })
    expect(assistant.calls).toHaveLength(1)
    expect(await ctx.db.select().from(messages).where(eq(messages.direction, 'in'))).toHaveLength(2)
  })

  it('passes conversation history to the assistant, oldest first', async () => {
    const assistant = new FakeAssistant((input) => ({ text: `reply to: ${input.text}`, toolCalls: [] }))
    ctx = await createTestApp({ assistant })
    await ctx.channel.receive({ text: 'first question' })
    await ctx.channel.receive({ text: 'second question' })
    const last = assistant.calls.at(-1)!
    expect(last.text).toBe('second question')
    expect(last.history.at(-2)).toEqual({ role: 'user', content: 'first question' })
    expect(last.history.at(-1)!.content).toContain('reply to: first question')
  })

  it('rate-limits a user who sends too many messages, telling them once', async () => {
    ctx = await createTestApp({ env: { RATE_LIMIT_MAX: '3' } })
    for (let i = 0; i < 6; i++) await ctx.channel.receive({ text: `msg ${i}` })
    const notices = ctx.channel.sent.filter((s) => s.text.includes('a bit fast'))
    expect(notices).toHaveLength(1)
  })

  it('ignores numbers that are not on the allowlist', async () => {
    ctx = await createTestApp({ env: { WA_ALLOWLIST: '447911123456' } })
    await ctx.channel.receive({ text: 'hi' })
    expect(ctx.channel.sent).toHaveLength(0)
    expect(await ctx.db.select().from(users)).toHaveLength(0)
  })

  it('tells the user to try later when every model is unavailable', async () => {
    const assistant = new FakeAssistant(() => {
      throw new AssistantUnavailableError(new Error('429'))
    })
    ctx = await createTestApp({ assistant })
    await ctx.channel.receive({ text: 'hi' })
    await ctx.channel.receive({ text: 'add a task' })
    expect(ctx.channel.last().text).toContain('try again in a minute')
  })

  it('transcribes voice notes and treats them as text', async () => {
    const assistant = new FakeAssistant()
    ctx = await createTestApp({ assistant })
    await ctx.channel.receive({ text: 'hi' })
    const msg = await ctx.channel.receive({ type: 'audio' })
    expect(assistant.calls.at(-1)!.text).toBe('remind me to buy milk at 6pm')
    const [row] = await ctx.db.select().from(messages).where(eq(messages.waMessageId, msg.id))
    expect(row!.content).toBe('🎤 remind me to buy milk at 6pm')
  })

  it('explains unsupported message types', async () => {
    ctx = await createTestApp()
    await ctx.channel.receive({ text: 'hi' })
    await ctx.channel.receive({ type: 'unsupported' })
    expect(ctx.channel.last().text).toContain('text and voice notes')
  })
})

describe('commands (no LLM)', () => {
  async function setup() {
    const assistant = new FakeAssistant()
    ctx = await createTestApp({ assistant })
    await ctx.channel.receive({ text: 'hi' })
    const [user] = await ctx.db.select().from(users)
    const due = (iso: string) => parseLocalDue(iso, ZONE)!
    await ctx.app.tasks.create(user!.id, { title: 'Morning standup', due: due('2026-10-26T11:00') })
    await ctx.app.tasks.create(user!.id, { title: 'Submit assignment', due: due('2026-10-27T10:00') })
    await ctx.app.tasks.create(user!.id, { title: 'Review portfolio', due: due('2026-10-30') })
    await ctx.app.tasks.create(user!.id, { title: 'Read a book', due: due('2026-11-20') })
    return { assistant, user: user! }
  }

  it('/today, /week and /tasks list the right tasks', async () => {
    const { assistant } = await setup()
    await ctx.channel.receive({ text: '/today' })
    expect(ctx.channel.last().text).toContain('*#1* Morning standup — today, 11:00 AM')
    expect(ctx.channel.last().text).not.toContain('Submit')

    await ctx.channel.receive({ text: '/week' })
    expect(ctx.channel.last().text).toContain('*#2* Submit assignment — tomorrow, 10:00 AM')
    expect(ctx.channel.last().text).toContain('*#3* Review portfolio — Friday')
    expect(ctx.channel.last().text).not.toContain('Read a book')

    await ctx.channel.receive({ text: '/tasks' })
    expect(ctx.channel.last().text).toContain('Open tasks (4)')
    expect(assistant.calls).toHaveLength(0)
  })

  it('/today shows overdue tasks separately', async () => {
    await setup()
    ctx.clock.set(new Date('2026-10-27T07:00:00Z')) // Tue 12:00
    await ctx.channel.receive({ text: '/today' })
    expect(ctx.channel.last().text).toMatch(/Overdue\*\n\*#1\* Morning standup/)
  })

  it('/done and /undo', async () => {
    await setup()
    await ctx.channel.receive({ text: '/done 2' })
    expect(ctx.channel.last().text).toBe('✅ "Submit assignment" marked as completed.')
    await ctx.channel.receive({ text: '/undo' })
    expect(ctx.channel.last().text).toContain('open again')
    await ctx.channel.receive({ text: '/done 99' })
    expect(ctx.channel.last().text).toBe("There's no task #99.")
  })

  it('/reset needs confirmation and then deletes everything', async () => {
    await setup()
    await ctx.channel.receive({ text: '/reset' })
    expect(ctx.channel.last().text).toContain('/reset confirm')
    await ctx.channel.receive({ text: '/reset confirm' })
    expect(ctx.channel.last().text).toContain('deleted')
    expect(await ctx.db.select().from(users)).toHaveLength(0)
  })

  it('/settings shows the timezone and daily summary', async () => {
    await setup()
    await ctx.channel.receive({ text: '/settings' })
    expect(ctx.channel.last().text).toContain('Timezone: *Asia/Karachi*')
    expect(ctx.channel.last().text).toContain('Daily summary: *off*')
  })
})

describe('daily summary', () => {
  it('is sent once per day at the chosen local time', async () => {
    ctx = await createTestApp()
    const { user } = await ctx.app.users.touch({ id: `${PHONE}@s.whatsapp.net`, phone: PHONE }, 'Taha')
    await ctx.app.users.updatePreferences(user.id, { digestTime: '08:00' })
    await ctx.app.tasks.create(user.id, { title: 'Gym', due: parseLocalDue('2026-10-26T18:00', ZONE)! })

    ctx.clock.set(new Date('2026-10-26T02:59:00Z')) // 07:59 local
    await ctx.app.scheduler.tick()
    expect(ctx.channel.sent).toHaveLength(0)

    ctx.clock.set(new Date('2026-10-26T03:00:00Z')) // 08:00 local
    await ctx.app.scheduler.tick()
    await ctx.app.scheduler.tick()
    expect(ctx.channel.sent).toHaveLength(1)
    expect(ctx.channel.last().text).toContain('Good morning, Taha')
    expect(ctx.channel.last().text).toContain('*#1* Gym — today, 6:00 PM')

    ctx.clock.set(new Date('2026-10-27T03:01:00Z')) // next day
    await ctx.app.scheduler.tick()
    expect(ctx.channel.sent).toHaveLength(2)
  })

  it('is skipped if the bot was down for the whole morning window', async () => {
    ctx = await createTestApp()
    const { user } = await ctx.app.users.touch({ id: `${PHONE}@s.whatsapp.net`, phone: PHONE }, 'Taha')
    await ctx.app.users.updatePreferences(user.id, { digestTime: '08:00' })
    ctx.clock.set(new Date('2026-10-26T09:00:00Z')) // 14:00 local
    await ctx.app.scheduler.tick()
    expect(ctx.channel.sent).toHaveLength(0)
  })
})
