import { randomUUID } from 'node:crypto'
import { createInterface, type Interface } from 'node:readline'
import type { Channel, IncomingMessage, SentRef, UserAddress } from '../types.js'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`

/**
 * Chat with the bot in the terminal — no phone needed. Type a message and press Enter.
 * Start a line with ">" to reply to (quote) the bot's last message, e.g. "> done".
 */
export class CliChannel implements Channel {
  readonly name = 'cli'
  private rl?: Interface
  private handler?: (msg: IncomingMessage) => Promise<void>
  private lastBotMessageId?: string
  private readonly user: UserAddress

  constructor(
    phone: string,
    private readonly pushName = process.env.CLI_NAME,
  ) {
    this.user = { id: `${phone}@cli`, phone }
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    this.rl = createInterface({ input: process.stdin, output: process.stdout, prompt: green('you › ') })
    this.rl.on('line', (line) => {
      const quoting = line.startsWith('>')
      const text = (quoting ? line.slice(1) : line).trim()
      if (!text) return this.rl?.prompt()
      void this.handler?.({
        id: `cli-in-${randomUUID()}`,
        from: this.user,
        pushName: this.pushName,
        type: 'text',
        text,
        quotedId: quoting ? this.lastBotMessageId : undefined,
        timestamp: new Date(),
      })
    })
    this.rl.prompt()
  }

  async stop(): Promise<void> {
    this.rl?.close()
  }

  async sendText(_to: UserAddress, text: string): Promise<SentRef> {
    const id = `cli-out-${randomUUID()}`
    this.lastBotMessageId = id
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    process.stdout.write(`\r\x1b[K${dim(time)} 🤖 ${text.replace(/\n/g, '\n         ')}\n\n`)
    this.rl?.prompt()
    return { id }
  }

  async react(_to: UserAddress, _messageId: string, emoji: string): Promise<void> {
    process.stdout.write(`\r\x1b[K${dim(`(reacted ${emoji})`)}\n`)
  }

  async markRead(): Promise<void> {}
  async setTyping(): Promise<void> {}

  async downloadMedia(): Promise<{ data: Buffer; mimeType: string }> {
    throw new Error('The terminal channel has no media')
  }

  status() {
    return 'open' as const
  }

  linkInfo() {
    return null
  }
}
