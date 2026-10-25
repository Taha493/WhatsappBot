import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { LlmAssistant } from '../src/ai/agent.js'
import { AssistantUnavailableError } from '../src/ai/types.js'
import { createLogger } from '../src/lib/logger.js'
import { toLocalIso } from '../src/tasks/time.js'
import { createTestApp, PHONE, ZONE } from './helpers.js'

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}
const toolCall = (toolName: string, input: unknown, id = 'call-1') => ({
  content: [{ type: 'tool-call' as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: undefined },
  usage,
  warnings: [],
})
const text = (value: string) => ({
  content: [{ type: 'text' as const, text: value }],
  finishReason: { unified: 'stop' as const, raw: undefined },
  usage,
  warnings: [],
})
const failing = () =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error('429 rate limited')
    },
  })

type Ctx = Awaited<ReturnType<typeof createTestApp>>
let ctx: Ctx
beforeEach(async () => {
  ctx = await createTestApp()
})
afterEach(() => ctx.close())

async function setup(models: Array<{ ref: string; model: MockLanguageModelV4 }>) {
  const { user } = await ctx.app.users.touch({ id: `${PHONE}@s.whatsapp.net`, phone: PHONE }, 'Taha')
  const assistant = new LlmAssistant({
    models,
    tasks: ctx.app.tasks,
    users: ctx.app.users,
    clock: ctx.clock.fn,
    logger: createLogger('silent'),
  })
  return { user, assistant }
}

describe('LlmAssistant', () => {
  it('runs tool calls against the real task service and returns the final text', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCall('createTask', {
          title: 'Submit assignment',
          due: '2026-10-27T10:00',
          reminders: [{ minutesBefore: 0 }],
        }),
        text("Done! I'll remind you tomorrow at 10:00 AM."),
      ],
    })
    const { user, assistant } = await setup([{ ref: 'mock:primary', model }])
    const out = await assistant.reply({ user, text: 'Remind me to submit my assignment tomorrow at 10 AM', history: [] })

    expect(out.text).toBe("Done! I'll remind you tomorrow at 10:00 AM.")
    expect(out.model).toBe('mock:primary')
    expect(out.toolCalls).toHaveLength(1)
    expect(out.toolCalls[0]).toMatchObject({ name: 'createTask', output: { ok: true, task: { number: 1, dueText: 'tomorrow, 10:00 AM' } } })

    const task = await ctx.app.tasks.get(user.id, 1)
    expect(toLocalIso(task.dueAt!, ZONE)).toBe('2026-10-27T10:00')
    expect(task.reminders).toHaveLength(1)
  })

  it('gives the model the current local time and the open tasks', async () => {
    const model = new MockLanguageModelV4({ doGenerate: [text('You have one task.')] })
    const { user, assistant } = await setup([{ ref: 'mock', model }])
    await ctx.app.tasks.create(user.id, { title: 'Prepare presentation' })
    await assistant.reply({ user, text: 'what do I have?', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello!' }] })

    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt)
    expect(prompt).toContain('Monday, 26 October 2026, 09:00')
    expect(prompt).toContain('#1 | Prepare presentation')
    expect(prompt).toContain('Fri 2026-10-30')
    expect(prompt).toContain('This week: 2026-10-26 to 2026-11-01. Next week: 2026-11-02 to 2026-11-08.')
    expect(prompt).toContain('hello!')
  })

  it('returns tool errors to the model instead of crashing', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [toolCall('completeTask', { taskNumber: 7 }), text("I couldn't find task #7.")],
    })
    const { user, assistant } = await setup([{ ref: 'mock', model }])
    const out = await assistant.reply({ user, text: 'complete 7', history: [] })
    expect(out.toolCalls[0]!.output).toEqual({ ok: false, error: "There's no task #7." })
    expect(out.text).toBe("I couldn't find task #7.")
  })

  it('falls back to the second model when the first fails before doing anything', async () => {
    const fallback = new MockLanguageModelV4({ doGenerate: [text('Hi from the fallback')] })
    const { user, assistant } = await setup([
      { ref: 'mock:primary', model: failing() },
      { ref: 'mock:fallback', model: fallback },
    ])
    const out = await assistant.reply({ user, text: 'hi', history: [] })
    expect(out).toMatchObject({ text: 'Hi from the fallback', model: 'mock:fallback' })
  })

  it('confirms what was saved when the model fails after a change (no retry, no duplicates)', async () => {
    let call = 0
    const primary = new MockLanguageModelV4({
      doGenerate: async () => {
        if (call++ === 0) return toolCall('createTask', { title: 'Buy milk', due: '2026-10-26T18:00', reminders: [{ minutesBefore: 0 }] })
        throw new Error('429 rate limited')
      },
    })
    const fallback = new MockLanguageModelV4({ doGenerate: [text('should not be used')] })
    const { user, assistant } = await setup([
      { ref: 'mock:primary', model: primary },
      { ref: 'mock:fallback', model: fallback },
    ])
    const out = await assistant.reply({ user, text: 'remind me to buy milk at 6pm', history: [] })
    expect(out.text).toBe('✅ Added *Buy milk* — today, 6:00 PM ⏰')
    expect(out.model).toBe('mock:primary (interrupted)')
    expect(fallback.doGenerateCalls).toHaveLength(0)
    expect(await ctx.app.tasks.list(user.id)).toHaveLength(1)
  })

  it('still falls back when only read-only tools ran before the failure', async () => {
    let call = 0
    const primary = new MockLanguageModelV4({
      doGenerate: async () => {
        if (call++ === 0) return toolCall('listTasks', {})
        throw new Error('503')
      },
    })
    const fallback = new MockLanguageModelV4({ doGenerate: [text('You have no tasks.')] })
    const { user, assistant } = await setup([
      { ref: 'mock:primary', model: primary },
      { ref: 'mock:fallback', model: fallback },
    ])
    const out = await assistant.reply({ user, text: 'what do I have?', history: [] })
    expect(out).toMatchObject({ text: 'You have no tasks.', model: 'mock:fallback' })
  })

  it('reports unavailable when every model fails without changing anything', async () => {
    const { user, assistant } = await setup([
      { ref: 'a', model: failing() },
      { ref: 'b', model: failing() },
    ])
    await expect(assistant.reply({ user, text: 'hi', history: [] })).rejects.toBeInstanceOf(AssistantUnavailableError)
  })

  it('updates the timezone and uses it for the rest of the turn', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCall('updatePreferences', { timezone: 'Europe/London' }, 'c1'),
        toolCall('createTask', { title: 'Call Sam', due: '2026-10-26T18:00' }, 'c2'),
        text('Done'),
      ],
    })
    const { user, assistant } = await setup([{ ref: 'mock', model }])
    await assistant.reply({ user, text: "I'm in London. Call Sam at 6pm", history: [] })
    const task = await ctx.app.tasks.get(user.id, 1)
    expect(toLocalIso(task.dueAt!, 'Europe/London')).toBe('2026-10-26T18:00')
    expect((await ctx.app.users.get(user.id))!.timezone).toBe('Europe/London')
  })
})
