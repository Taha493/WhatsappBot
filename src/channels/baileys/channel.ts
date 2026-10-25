import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WAMessage,
  type WASocket,
  type proto,
} from 'baileys'
import qrcodeTerminal from 'qrcode-terminal'
import type { Db } from '../../db/client.js'
import type { Logger } from '../../lib/logger.js'
import type { Channel, ChannelStatus, IncomingMessage, LinkInfo, SentRef, UserAddress } from '../types.js'
import { usePostgresAuthState } from './auth-store.js'
import { resolveSender, shouldIgnoreJid, toIncoming } from './mapping.js'

type Options = {
  db: Db
  logger: Logger
  linkMethod: 'qr' | 'pairing'
  pairingPhone?: string
}

const MAX_BACKOFF_MS = 60_000
/** Recently sent messages, kept so WhatsApp's retry requests can be answered. */
const SENT_CACHE_SIZE = 500

/**
 * WhatsApp via Baileys (WhatsApp Web multi-device protocol). The bot is a linked device
 * on the spare number. The session lives in Postgres, so restarts don't need a new QR.
 */
export class BaileysChannel implements Channel {
  readonly name = 'whatsapp'
  private sock?: WASocket
  private handler?: (msg: IncomingMessage) => Promise<void>
  private state: ChannelStatus = 'closed'
  private link: LinkInfo = null
  private stopped = false
  private attempt = 0
  private reconnectTimer?: NodeJS.Timeout
  private readonly sentCache = new Map<string, proto.IMessage>()
  private readonly baileysLogger: Logger

  constructor(private readonly opts: Options) {
    this.baileysLogger = opts.logger.child({ module: 'baileys' }, { level: 'warn' })
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler
  }

  status(): ChannelStatus {
    return this.state
  }

  linkInfo(): LinkInfo {
    return this.link
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    this.sock?.end(undefined)
    this.state = 'closed'
  }

  private async connect(): Promise<void> {
    const { logger, db } = this.opts
    this.state = 'connecting'
    const auth = await usePostgresAuthState(db)
    const version = await fetchLatestBaileysVersion()
      .then((v) => v.version)
      .catch(() => undefined)

    const sock = makeWASocket({
      auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, this.baileysLogger) },
      logger: this.baileysLogger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldIgnoreJid,
      getMessage: async (key) => (key.id ? this.sentCache.get(key.id) : undefined),
      ...(version ? { version } : {}),
    })
    this.sock = sock
    let pairingRequested = false

    sock.ev.on('creds.update', auth.saveCreds)

    sock.ev.on('connection.update', async (update) => {
      if (update.qr) {
        if (this.opts.linkMethod === 'pairing' && this.opts.pairingPhone) {
          if (!pairingRequested) {
            pairingRequested = true
            try {
              const code = await sock.requestPairingCode(this.opts.pairingPhone)
              this.link = { method: 'pairing', code }
              logger.warn(
                `\n\n  Link the bot: WhatsApp on the bot phone → Linked devices → Link with phone number → enter code  ${code}\n`,
              )
            } catch (err) {
              logger.error({ err }, 'Could not request a pairing code')
            }
          }
        } else {
          this.link = { method: 'qr', qr: update.qr }
          logger.warn('Scan this QR code with the bot phone: WhatsApp → Linked devices → Link a device')
          qrcodeTerminal.generate(update.qr, { small: true })
        }
      }

      if (update.connection === 'open') {
        this.state = 'open'
        this.link = null
        this.attempt = 0
        logger.info({ me: sock.user?.id }, 'WhatsApp connected')
      }

      if (update.connection === 'close') {
        const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode
        if (this.stopped) return
        if (code === DisconnectReason.loggedOut) {
          this.state = 'logged_out'
          logger.error('WhatsApp session was logged out. Clearing it — link the bot again (QR / pairing code).')
          await auth.clear()
          this.scheduleReconnect(2000)
          return
        }
        this.state = 'connecting'
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(1000 * 2 ** this.attempt++, MAX_BACKOFF_MS)
        logger.warn({ code, delay }, 'WhatsApp connection closed, reconnecting')
        this.scheduleReconnect(delay)
      }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const raw of messages) {
        try {
          const sender = await resolveSender(raw.key, (lid) => sock.signalRepository.lidMapping.getPNForLID(lid))
          const msg = sender ? toIncoming(raw, sender) : null
          if (msg && this.handler) void this.handler(msg)
        } catch (err) {
          logger.error({ err }, 'Failed to read incoming WhatsApp message')
        }
      }
    })
  }

  private scheduleReconnect(delay: number) {
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        this.opts.logger.error({ err }, 'Reconnect failed')
        this.scheduleReconnect(Math.min(1000 * 2 ** this.attempt++, MAX_BACKOFF_MS))
      })
    }, delay)
  }

  private socket(): WASocket {
    if (!this.sock || this.state !== 'open') throw new Error(`WhatsApp is not connected (${this.state})`)
    return this.sock
  }

  async sendText(to: UserAddress, text: string, opts?: { quoteId?: string }): Promise<SentRef> {
    const quoted = opts?.quoteId
      ? ({ key: { remoteJid: to.id, id: opts.quoteId, fromMe: false }, message: { conversation: '' } } as WAMessage)
      : undefined
    const sent = await this.socket().sendMessage(to.id, { text }, quoted ? { quoted } : undefined)
    const id = sent?.key.id ?? ''
    if (id && sent?.message) {
      this.sentCache.set(id, sent.message)
      if (this.sentCache.size > SENT_CACHE_SIZE) this.sentCache.delete(this.sentCache.keys().next().value!)
    }
    return { id }
  }

  async react(to: UserAddress, messageId: string, emoji: string): Promise<void> {
    await this.socket().sendMessage(to.id, {
      react: { text: emoji, key: { remoteJid: to.id, id: messageId, fromMe: false } },
    })
  }

  async markRead(msg: IncomingMessage): Promise<void> {
    const raw = msg.raw as WAMessage | undefined
    if (raw?.key) await this.socket().readMessages([raw.key])
  }

  async setTyping(to: UserAddress, on: boolean): Promise<void> {
    await this.socket().sendPresenceUpdate(on ? 'composing' : 'paused', to.id)
  }

  async downloadMedia(msg: IncomingMessage): Promise<{ data: Buffer; mimeType: string }> {
    const raw = msg.raw as WAMessage
    const sock = this.socket()
    const data = await downloadMediaMessage(
      raw,
      'buffer',
      {},
      { logger: this.baileysLogger, reuploadRequest: sock.updateMediaMessage },
    )
    const mimeType = raw.message?.audioMessage?.mimetype ?? 'audio/ogg'
    return { data, mimeType }
  }
}
