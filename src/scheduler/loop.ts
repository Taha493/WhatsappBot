import type { Logger } from '../lib/logger.js'
import type { TaskService } from '../tasks/service.js'
import type { UserService } from '../core/users.js'
import type { DigestSender } from './digest.js'
import type { ReminderDispatcher } from './reminders.js'

/** A recurring occurrence left uncompleted this long moves on to the next one. */
const RECURRING_GRACE_MS = 6 * 60 * 60_000

type Deps = {
  reminders: ReminderDispatcher
  digest: DigestSender
  tasks: TaskService
  users: UserService
  /** Sending is skipped while the channel is disconnected; work stays in the database. */
  canSend: () => boolean
  logger: Logger
}

/** In-process scheduler: one tick every N seconds, never overlapping. */
export class Scheduler {
  private timer?: NodeJS.Timeout
  private running?: Promise<void>

  constructor(private readonly d: Deps) {}

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.tick(), intervalMs)
    void this.tick()
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    await this.running
  }

  /** Runs one tick (skipped if the previous one is still running). */
  tick(): Promise<void> {
    if (this.running) return this.running
    this.running = this.runOnce().finally(() => (this.running = undefined))
    return this.running
  }

  private async runOnce(): Promise<void> {
    const { logger } = this.d
    try {
      const advanced = await this.d.tasks.advanceMissedRecurring((id) => this.d.users.zoneFor(id), RECURRING_GRACE_MS)
      if (advanced) logger.info({ advanced }, 'Advanced missed recurring tasks')
      if (!this.d.canSend()) return
      const reminders = await this.d.reminders.run()
      const digests = await this.d.digest.run()
      if (reminders || digests) logger.info({ reminders, digests }, 'Scheduler sent messages')
    } catch (err) {
      logger.error({ err }, 'Scheduler tick failed')
    }
  }
}
