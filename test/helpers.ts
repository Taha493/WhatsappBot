import { sql } from 'drizzle-orm'
import { createApp } from '../src/app.js'
import type { Assistant, AssistantInput, AssistantOutput } from '../src/ai/types.js'
import type { Channel, ChannelStatus, IncomingMessage, SentRef, UserAddress } from '../src/channels/types.js'
import { loadEnv } from '../src/config/env.js'
import { openDatabase, type DbHandle } from '../src/db/client.js'
import { createLogger } from '../src/lib/logger.js'

/** Monday 26 Oct 2026, 09:00 in Asia/Karachi (UTC+5). */
export const MONDAY_9AM = new Date('2026-10-26T04:00:00Z')
export const ZONE = 'Asia/Karachi'
/** A Pakistani number, so the timezone is guessed as Asia/Karachi. */
export const PHONE = '923001234567'

export class TestClock {
  constructor(public now: Date = MONDAY_9AM) {}
  fn = () => new Date(this.now)
  advance(ms: number) {
    this.now = new Date(this.now.getTime() + ms)
  }
  set(date: Date) {
    this.now = new Date(date)
  }
}

export const minutes = (n: number) => n * 60_000
export const hours = (n: number) => n * 3_600_000

type Sent = { to: string; text: string; id: string }

/** In-memory channel that records everything the bot sends. */
export class FakeChannel implements Channel {
  readonly name = 'fake'
  sent: Sent[] = []
  reactions: Array<{ messageId: string; emoji: string }> = []
  state: ChannelStatus = 'open'
  failSends = false
  private handler?: (msg: IncomingMessage) => Promise<void>
  private counter = 0

  onMessage(handler: (msg: IncomingMessage) => Promise<void>) {
    this.handler = handler
  }
  async start() {}
  async stop() {}
  async sendText(to: UserAddress, text: string): Promise<SentRef> {
    if (this.failSends) throw new Error('send failed')
    const id = `out-${++this.counter}`
    this.sent.push({ to: to.id, text, id })
    return { id }
  }
  async react(_to: UserAddress, messageId: string, emoji: string) {
    this.reactions.push({ messageId, emoji })
  }
  async markRead() {}
  async setTyping() {}
  async downloadMedia() {
    return { data: Buffer.from('fake-audio'), mimeType: 'audio/ogg' }
  }
  status() {
    return this.state
  }
  linkInfo() {
    return null
  }

  /** Simulates a user message and waits until the bot has handled it. */
  async receive(partial: Partial<IncomingMessage> & { text?: string }) {
    const msg: IncomingMessage = {
      id: partial.id ?? `in-${++this.counter}`,
      from: partial.from ?? { id: `${PHONE}@s.whatsapp.net`, phone: PHONE },
      pushName: partial.pushName ?? 'Taha',
      type: partial.type ?? 'text',
      text: partial.text,
      quotedId: partial.quotedId,
      timestamp: partial.timestamp ?? new Date(),
    }
    await this.handler!(msg)
    return msg
  }

  last(): Sent {
    return this.sent.at(-1)!
  }
  clear() {
    this.sent = []
    this.reactions = []
  }
}

/** Assistant stub: records inputs and returns scripted replies (or runs a callback). */
export class FakeAssistant implements Assistant {
  calls: AssistantInput[] = []
  constructor(private readonly respond: (input: AssistantInput) => Promise<AssistantOutput> | AssistantOutput = () => ({ text: 'ok', toolCalls: [] })) {}
  async reply(input: AssistantInput) {
    this.calls.push(input)
    return this.respond(input)
  }
}

/** One in-memory database per test file (booting PGlite is slow); tables are emptied per test. */
let shared: Promise<DbHandle> | undefined
async function freshDatabase(): Promise<DbHandle> {
  shared ??= openDatabase('memory://')
  const handle = await shared
  await handle.db.execute(
    sql.raw('TRUNCATE users, tasks, reminders, task_events, messages, wa_auth RESTART IDENTITY CASCADE'),
  )
  return handle
}

export async function createTestApp(opts: { assistant?: Assistant; env?: Record<string, string> } = {}) {
  const clock = new TestClock()
  const handle = await freshDatabase()
  const channel = new FakeChannel()
  const env = loadEnv({ LLM_PRIMARY: 'google:test-model', ...opts.env })
  const assistant = opts.assistant ?? new FakeAssistant()
  const app = createApp({
    env,
    db: handle.db,
    channel,
    logger: createLogger(process.env.TEST_LOG_LEVEL ?? 'silent'),
    clock: clock.fn,
    assistant,
    transcriber: { transcribe: async () => 'remind me to buy milk at 6pm' },
    outbound: { minGapMs: 0, jitterMs: 0, typing: false },
  })
  // Tests that pass their own assistant keep their own reference to it.
  return { app, db: handle.db, channel, clock, assistant: assistant as FakeAssistant, close: async () => {} }
}
