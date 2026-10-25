import { DateTime } from 'luxon'
import type { Channel, IncomingMessage, UserAddress } from '../channels/types.js'
import type { User } from '../db/schema.js'
import { maskId, type Logger } from '../lib/logger.js'
import { AssistantUnavailableError, type Assistant, type ToolCallRecord } from '../ai/types.js'
import type { Transcriber } from '../ai/transcribe.js'
import { TaskError } from '../tasks/errors.js'
import type { DueReminder, ReminderService } from '../tasks/reminders.js'
import type { TaskService } from '../tasks/service.js'
import { formatDue, type Clock } from '../tasks/time.js'
import { runCommand } from './commands.js'
import type { ConversationLog } from './conversation.js'
import type { Outbound } from './outbound.js'
import { parseQuickAction, type QuickAction } from './quick-actions.js'
import { isGreeting, texts } from './texts.js'
import type { KeyedQueue } from './user-queue.js'
import type { UserService } from './users.js'

export type HandlerConfig = {
  /** Digits-only numbers allowed to use the bot; empty = everyone. */
  allowlist: string[]
  rateLimitMax: number
  rateLimitWindowMs: number
  historyLimit: number
}

export type HandlerDeps = {
  channel: Channel
  outbound: Outbound
  queue: KeyedQueue
  users: UserService
  tasks: TaskService
  reminders: ReminderService
  conversation: ConversationLog
  assistant: Assistant
  transcriber?: Transcriber
  clock: Clock
  logger: Logger
  config: HandlerConfig
}

/** Handles one incoming message end to end. Messages from the same user run in order. */
export class MessageHandler {
  constructor(private readonly d: HandlerDeps) {}

  handle = (msg: IncomingMessage): Promise<void> =>
    this.d.queue.run(msg.from.id, async () => {
      try {
        await this.process(msg)
      } catch (err) {
        this.d.logger.error({ err, messageId: msg.id }, 'Failed to handle message')
        await this.d.outbound.sendText(msg.from, texts.error).catch(() => {})
      }
    })

  private async process(msg: IncomingMessage): Promise<void> {
    const { users, conversation, config, channel, logger } = this.d

    if (config.allowlist.length && !(msg.from.phone && config.allowlist.includes(msg.from.phone))) {
      logger.info({ from: maskId(msg.from.id) }, 'Ignoring message from a number not on the allowlist')
      return
    }

    const { user, isNew } = await users.touch(msg.from, msg.pushName)
    if (!(await conversation.recordIncoming(user.id, msg.id, msg.type, msg.text ?? null))) {
      logger.debug({ messageId: msg.id }, 'Duplicate message ignored')
      return
    }

    const since = new Date(this.d.clock().getTime() - config.rateLimitWindowMs)
    const recent = await users.incomingCountSince(user.id, since)
    if (recent > config.rateLimitMax) {
      if (recent === config.rateLimitMax + 1) await this.reply(user, msg.from, texts.rateLimited)
      return
    }

    await channel.markRead(msg).catch(() => {})

    if (isNew) {
      const zone = users.zoneOf(user)
      await this.reply(user, msg.from, texts.welcome(user.name, zone, this.d.clock(), Boolean(user.timezone)))
      await users.markOnboarded(user.id)
      if (msg.type === 'text' && isGreeting(msg.text)) return
    }

    let text = msg.text?.trim()
    if (msg.type === 'unsupported') return this.reply(user, msg.from, texts.unsupported)
    if (msg.type === 'audio') {
      const transcript = await this.transcribe(msg, user)
      if (transcript === null) return
      text = transcript
    }
    if (!text) return

    if (msg.quotedId) {
      const reminder = await this.d.reminders.findByMessageId(user.id, msg.quotedId)
      if (reminder) {
        const action = parseQuickAction(text)
        if (action) {
          const reply = await this.applyQuickAction(user, reminder, action)
          await this.d.outbound.react(msg.from, msg.id, '✅').catch(() => {})
          return this.reply(user, msg.from, reply)
        }
        text = `[Replying to the reminder for task #${reminder.task.number} "${reminder.task.title}"] ${text}`
      }
    }

    if (text.startsWith('/')) {
      const reply = await runCommand(text, {
        user,
        zone: users.zoneOf(user),
        now: this.d.clock(),
        tasks: this.d.tasks,
        users,
      })
      // After /reset confirm the user row is gone, so don't log against it.
      if (reply === texts.resetDone) {
        await this.d.outbound.sendText(msg.from, reply)
        return
      }
      return this.reply(user, msg.from, reply)
    }

    await channel.setTyping(msg.from, true).catch(() => {})
    try {
      const history = await conversation.history(user.id, config.historyLimit, msg.id)
      const result = await this.d.assistant.reply({ user, text, history })
      logger.info({ model: result.model, tools: result.toolCalls.map((c) => c.name) }, 'Assistant replied')
      await this.reply(user, msg.from, result.text, result.toolCalls)
    } catch (err) {
      if (!(err instanceof AssistantUnavailableError)) throw err
      await channel.setTyping(msg.from, false).catch(() => {})
      await this.reply(user, msg.from, texts.busy, undefined, String(err.cause ?? err))
    }
  }

  /** Returns the transcript, or null when a reply was already sent instead. */
  private async transcribe(msg: IncomingMessage, user: User): Promise<string | null> {
    if (!this.d.transcriber) {
      await this.reply(user, msg.from, texts.voiceDisabled)
      return null
    }
    await this.d.channel.setTyping(msg.from, true).catch(() => {})
    const { data } = await this.d.channel.downloadMedia(msg)
    const transcript = await this.d.transcriber.transcribe(data)
    if (!transcript) {
      await this.reply(user, msg.from, texts.voiceEmpty)
      return null
    }
    await this.d.conversation.setContent(msg.id, `🎤 ${transcript}`)
    return transcript
  }

  private async applyQuickAction(user: User, { reminder, task }: DueReminder, action: QuickAction): Promise<string> {
    const zone = this.d.users.zoneOf(user)
    const now = this.d.clock()
    try {
      if (action.kind === 'done') {
        const { nextDue } = await this.d.tasks.complete(user.id, task.number, zone)
        return nextDue
          ? `✅ Marked *${task.title}* as done. Next time: ${formatDue(nextDue, task.allDay, zone, now)}.`
          : `✅ Marked *${task.title}* as done.`
      }
      const at =
        action.kind === 'snooze'
          ? new Date(now.getTime() + action.minutes * 60_000)
          : (() => {
              const original = DateTime.fromJSDate(reminder.remindAt, { zone })
              return DateTime.fromJSDate(now, { zone })
                .plus({ days: 1 })
                .set({ hour: original.hour, minute: original.minute, second: 0, millisecond: 0 })
                .toJSDate()
            })()
      await this.d.tasks.addReminder(user.id, task.number, { at })
      return `⏰ Okay, I'll remind you about *${task.title}* ${formatDue(at, false, zone, now)}.`
    } catch (err) {
      if (err instanceof TaskError) {
        return err.code === 'conflict' ? `That one's already done 👍` : err.message
      }
      throw err
    }
  }

  private async reply(
    user: User,
    to: UserAddress,
    text: string,
    toolCalls?: ToolCallRecord[],
    error?: string,
  ): Promise<void> {
    const sent = await this.d.outbound.sendText(to, text)
    await this.d.conversation.recordOutgoing(user.id, {
      waMessageId: sent.id || null,
      content: text,
      toolCalls,
      error,
    })
  }
}
