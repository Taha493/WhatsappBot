import { LlmAssistant } from './ai/agent.js'
import { modelChain } from './ai/providers.js'
import { GroqTranscriber, type Transcriber } from './ai/transcribe.js'
import type { Assistant } from './ai/types.js'
import type { Channel } from './channels/types.js'
import type { Env } from './config/env.js'
import { ConversationLog } from './core/conversation.js'
import { MessageHandler } from './core/handler.js'
import { DEFAULT_OUTBOUND, Outbound, type OutboundOptions } from './core/outbound.js'
import { KeyedQueue } from './core/user-queue.js'
import { UserService } from './core/users.js'
import type { Db } from './db/client.js'
import type { Logger } from './lib/logger.js'
import { DigestSender } from './scheduler/digest.js'
import { Scheduler } from './scheduler/loop.js'
import { ReminderDispatcher } from './scheduler/reminders.js'
import { ReminderService } from './tasks/reminders.js'
import { TaskService } from './tasks/service.js'
import { systemClock, type Clock } from './tasks/time.js'

export type AppOptions = {
  env: Env
  db: Db
  channel: Channel
  logger: Logger
  clock?: Clock
  /** Overrides for tests and evals. */
  assistant?: Assistant
  transcriber?: Transcriber
  outbound?: OutboundOptions
}

/** Builds every service and wires the channel to the handler. Channel-agnostic. */
export function createApp(opts: AppOptions) {
  const { env, db, channel, logger } = opts
  const clock = opts.clock ?? systemClock

  const users = new UserService(db, clock, env.DEFAULT_TIMEZONE)
  const reminders = new ReminderService(db, clock)
  const tasks = new TaskService(db, reminders, clock)
  const conversation = new ConversationLog(db, clock)
  const outbound = new Outbound(channel, opts.outbound ?? DEFAULT_OUTBOUND)
  const queue = new KeyedQueue()

  const assistant = opts.assistant ?? new LlmAssistant({ models: modelChain(env), tasks, users, clock, logger })
  const transcriber =
    opts.transcriber ?? (env.GROQ_API_KEY ? new GroqTranscriber(env.GROQ_API_KEY, env.TRANSCRIBE_MODEL) : undefined)

  const handler = new MessageHandler({
    channel,
    outbound,
    queue,
    users,
    tasks,
    reminders,
    conversation,
    assistant,
    transcriber,
    clock,
    logger,
    config: {
      allowlist: env.WA_ALLOWLIST,
      rateLimitMax: env.RATE_LIMIT_MAX,
      rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MINUTES * 60_000,
      historyLimit: 14,
    },
  })
  channel.onMessage(handler.handle)

  const scheduler = new Scheduler({
    reminders: new ReminderDispatcher({ reminders, users, outbound, conversation, clock, logger }),
    digest: new DigestSender({ db, users, tasks, outbound, conversation, clock, logger }),
    tasks,
    users,
    canSend: () => channel.status() === 'open',
    logger,
  })

  return {
    users,
    tasks,
    reminders,
    conversation,
    outbound,
    handler,
    scheduler,
    async start() {
      await channel.start()
      scheduler.start(env.SCHEDULER_INTERVAL_SECONDS * 1000)
    },
    /** Stops taking work, lets in-flight messages finish (up to 10 s), then disconnects. */
    async stop() {
      await scheduler.stop()
      await Promise.race([
        Promise.all([queue.idle(), outbound.idle()]),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ])
      await channel.stop()
    },
  }
}

export type App = ReturnType<typeof createApp>
