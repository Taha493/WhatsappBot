import {
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  normalizeMessageContent,
  type WAMessage,
  type WAMessageKey,
} from 'baileys'
import type { IncomingMessage, UserAddress } from '../types.js'

/** Messages older than this (e.g. a backlog after long downtime) are ignored. */
const MAX_AGE_MS = 24 * 60 * 60_000

/** Groups, broadcasts, status updates and channels are never handled. */
export function shouldIgnoreJid(jid: string): boolean {
  return Boolean(isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid))
}

const digits = (jid: string) => jid.split('@')[0]!.split(':')[0]!.replace(/\D/g, '')

/**
 * Works out who sent a message. WhatsApp increasingly addresses people by an anonymous
 * LID instead of their phone number; when the phone number is known (alt field or Baileys'
 * LID mapping) we key the user by it, so one person doesn't become two users.
 */
export async function resolveSender(
  key: WAMessageKey,
  lookupPn: (lid: string) => Promise<string | null>,
): Promise<UserAddress | null> {
  const remote = key.remoteJid
  if (!remote || key.fromMe || shouldIgnoreJid(remote)) return null

  if (isPnUser(remote)) {
    const id = jidNormalizedUser(remote)
    return { id, phone: digits(id) }
  }
  if (isLidUser(remote)) {
    const pn = key.remoteJidAlt && isPnUser(key.remoteJidAlt) ? key.remoteJidAlt : await lookupPn(remote).catch(() => null)
    if (pn) {
      const id = jidNormalizedUser(pn)
      return { id, phone: digits(id) }
    }
    return { id: jidNormalizedUser(remote) }
  }
  return null
}

const UNSUPPORTED = new Set([
  'imageMessage',
  'videoMessage',
  'stickerMessage',
  'documentMessage',
  'documentWithCaptionMessage',
  'locationMessage',
  'liveLocationMessage',
  'contactMessage',
  'contactsArrayMessage',
  'pollCreationMessage',
  'pollCreationMessageV3',
])

/** Converts a Baileys message into the channel-neutral shape. Returns null for things to ignore. */
export function toIncoming(raw: WAMessage, from: UserAddress, now = Date.now()): IncomingMessage | null {
  const id = raw.key.id
  const content = normalizeMessageContent(raw.message)
  if (!id || !content) return null

  const timestamp = new Date(Number(raw.messageTimestamp ?? 0) * 1000 || now)
  if (now - timestamp.getTime() > MAX_AGE_MS) return null

  const type = getContentType(content)
  const base = { id, from, pushName: raw.pushName ?? undefined, timestamp, raw }

  if (type === 'conversation' || type === 'extendedTextMessage') {
    const text = content.conversation ?? content.extendedTextMessage?.text ?? ''
    if (!text.trim()) return null
    const quotedId = content.extendedTextMessage?.contextInfo?.stanzaId ?? undefined
    return { ...base, type: 'text', text, quotedId }
  }
  if (type === 'audioMessage') {
    const quotedId = content.audioMessage?.contextInfo?.stanzaId ?? undefined
    return { ...base, type: 'audio', quotedId }
  }
  if (type && UNSUPPORTED.has(type)) return { ...base, type: 'unsupported' }
  // Reactions, edits, deletions, protocol messages… need no reply.
  return null
}
