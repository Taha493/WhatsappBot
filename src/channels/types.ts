/** Who a message is from / to. `id` is the channel's stable address for the user. */
export type UserAddress = {
  id: string
  /** Digits only, international format, when the channel knows it. */
  phone?: string
}

export type IncomingMessage = {
  /** Channel-unique message id (used for dedupe). */
  id: string
  from: UserAddress
  /** Display name the sender set for themselves. */
  pushName?: string
  type: 'text' | 'audio' | 'unsupported'
  text?: string
  /** Id of the message this one quotes (replies to), if any. */
  quotedId?: string
  timestamp: Date
  /** Channel-specific payload, needed e.g. to download media. */
  raw?: unknown
}

export type SentRef = { id: string }

export type ChannelStatus = 'connecting' | 'open' | 'closed' | 'logged_out'

export type LinkInfo =
  | { method: 'qr'; qr: string }
  | { method: 'pairing'; code: string }
  | null

export interface Channel {
  readonly name: string
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void
  sendText(to: UserAddress, text: string, opts?: { quoteId?: string }): Promise<SentRef>
  react(to: UserAddress, messageId: string, emoji: string): Promise<void>
  markRead(msg: IncomingMessage): Promise<void>
  setTyping(to: UserAddress, on: boolean): Promise<void>
  downloadMedia(msg: IncomingMessage): Promise<{ data: Buffer; mimeType: string }>
  status(): ChannelStatus
  /** Current QR / pairing code while waiting to be linked. */
  linkInfo(): LinkInfo
}
