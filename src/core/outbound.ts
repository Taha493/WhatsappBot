import PQueue from 'p-queue'
import type { Channel, SentRef, UserAddress } from '../channels/types.js'
import { splitMessage, toWhatsApp } from '../lib/format.js'

export type OutboundOptions = {
  /** Minimum gap between any two sends (ban-risk: avoid bursts). */
  minGapMs: number
  /** Random extra delay added to the gap. */
  jitterMs: number
  /** Show "typing…" before each message, for roughly as long as a person would take. */
  typing: boolean
}

export const DEFAULT_OUTBOUND: OutboundOptions = { minGapMs: 1000, jitterMs: 600, typing: true }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** All outgoing messages go through one throttled queue. */
export class Outbound {
  private readonly queue = new PQueue({ concurrency: 1 })
  private lastSentAt = 0

  constructor(
    private readonly channel: Channel,
    private readonly options: OutboundOptions = DEFAULT_OUTBOUND,
  ) {}

  /** Formats, splits and sends text. Resolves with the id of the last chunk sent. */
  async sendText(to: UserAddress, text: string): Promise<SentRef> {
    const chunks = splitMessage(toWhatsApp(text))
    let ref: SentRef = { id: '' }
    for (const chunk of chunks) {
      ref = await this.enqueue(async () => {
        if (this.options.typing) {
          await this.channel.setTyping(to, true).catch(() => {})
          await sleep(Math.min(500 + chunk.length * 12, 2500))
        }
        return this.channel.sendText(to, chunk)
      })
    }
    return ref
  }

  react(to: UserAddress, messageId: string, emoji: string): Promise<void> {
    return this.enqueue(() => this.channel.react(to, messageId, emoji))
  }

  /** Waits for queued messages to go out (used on shutdown). */
  idle(): Promise<void> {
    return this.queue.onIdle()
  }

  private enqueue<T>(send: () => Promise<T>): Promise<T> {
    return this.queue.add(async () => {
      const gap = this.options.minGapMs + Math.random() * this.options.jitterMs
      const wait = this.lastSentAt + gap - Date.now()
      if (wait > 0) await sleep(wait)
      try {
        return await send()
      } finally {
        this.lastSentAt = Date.now()
      }
    }) as Promise<T>
  }
}
