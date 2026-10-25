import { describe, expect, it } from 'vitest'
import { BufferJSON, type WAMessage } from 'baileys'
import { usePostgresAuthState } from '../src/channels/baileys/auth-store.js'
import { resolveSender, shouldIgnoreJid, toIncoming } from '../src/channels/baileys/mapping.js'
import { openDatabase } from '../src/db/client.js'

const NOW = Date.UTC(2026, 9, 26, 4, 0, 0)
const noLookup = async () => null

function message(partial: Partial<WAMessage> & { message: WAMessage['message'] }): WAMessage {
  return {
    key: { remoteJid: '923001234567@s.whatsapp.net', id: 'MSG1', fromMe: false },
    messageTimestamp: NOW / 1000,
    pushName: 'Taha',
    ...partial,
  } as WAMessage
}

describe('resolveSender', () => {
  it('uses the phone number JID directly', async () => {
    expect(await resolveSender({ remoteJid: '923001234567:12@s.whatsapp.net' }, noLookup)).toEqual({
      id: '923001234567@s.whatsapp.net',
      phone: '923001234567',
    })
  })

  it('prefers the phone number when a LID message carries it', async () => {
    const sender = await resolveSender(
      { remoteJid: '123456789012345@lid', remoteJidAlt: '923001234567@s.whatsapp.net' },
      noLookup,
    )
    expect(sender).toEqual({ id: '923001234567@s.whatsapp.net', phone: '923001234567' })
  })

  it('looks the phone number up for a LID, or falls back to the LID', async () => {
    expect(await resolveSender({ remoteJid: '1234@lid' }, async () => '447911123456@s.whatsapp.net')).toEqual({
      id: '447911123456@s.whatsapp.net',
      phone: '447911123456',
    })
    expect(await resolveSender({ remoteJid: '1234@lid' }, noLookup)).toEqual({ id: '1234@lid' })
  })

  it('ignores own messages, groups, broadcasts and status updates', async () => {
    expect(await resolveSender({ remoteJid: '923001234567@s.whatsapp.net', fromMe: true }, noLookup)).toBeNull()
    expect(await resolveSender({ remoteJid: '1203630@g.us' }, noLookup)).toBeNull()
    expect(shouldIgnoreJid('status@broadcast')).toBe(true)
    expect(shouldIgnoreJid('1203630@newsletter')).toBe(true)
  })
})

describe('toIncoming', () => {
  const from = { id: '923001234567@s.whatsapp.net', phone: '923001234567' }

  it('maps plain and extended text, including quoted replies', () => {
    expect(toIncoming(message({ message: { conversation: 'hello' } }), from, NOW)).toMatchObject({
      id: 'MSG1',
      type: 'text',
      text: 'hello',
      pushName: 'Taha',
    })
    const reply = toIncoming(
      message({ message: { extendedTextMessage: { text: 'done', contextInfo: { stanzaId: 'REMINDER1' } } } }),
      from,
      NOW,
    )
    expect(reply).toMatchObject({ type: 'text', text: 'done', quotedId: 'REMINDER1' })
  })

  it('maps voice notes and unsupported media', () => {
    expect(toIncoming(message({ message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } } }), from, NOW)?.type).toBe('audio')
    expect(toIncoming(message({ message: { imageMessage: { caption: 'look' } } }), from, NOW)?.type).toBe('unsupported')
  })

  it('ignores reactions, empty messages and old backlog', () => {
    expect(toIncoming(message({ message: { reactionMessage: { text: '👍' } } }), from, NOW)).toBeNull()
    expect(toIncoming(message({ message: { conversation: '   ' } }), from, NOW)).toBeNull()
    expect(toIncoming(message({ message: { conversation: 'hi' }, messageTimestamp: NOW / 1000 - 2 * 86400 }), from, NOW)).toBeNull()
  })
})

describe('Postgres auth state', () => {
  it('persists credentials and signal keys (with Buffers) across restarts', async () => {
    const handle = await openDatabase('memory://')
    const first = await usePostgresAuthState(handle.db)
    first.state.creds.registered = true
    await first.saveCreds()
    const key = { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) }
    await first.state.keys.set({ 'pre-key': { '7': key }, session: { 'abc:1': Buffer.from('session') } })

    const second = await usePostgresAuthState(handle.db)
    expect(second.state.creds.registered).toBe(true)
    expect(Buffer.from(second.state.creds.noiseKey.public)).toEqual(Buffer.from(first.state.creds.noiseKey.public))
    const keys = await second.state.keys.get('pre-key', ['7', '8'])
    expect(Buffer.from(keys['7']!.public)).toEqual(Buffer.from([1, 2, 3]))
    expect(keys['8']).toBeUndefined()

    await second.state.keys.set({ 'pre-key': { '7': null } })
    expect((await second.state.keys.get('pre-key', ['7']))['7']).toBeUndefined()

    // A fresh link saves ~800 pre-keys in one call; overwrites and deletes mix in later.
    const many = Object.fromEntries(
      Array.from({ length: 812 }, (_, i) => [String(100 + i), { public: Buffer.from([i % 256]), private: Buffer.from([1]) }]),
    )
    await second.state.keys.set({ 'pre-key': many })
    await second.state.keys.set({ 'pre-key': { '100': { public: Buffer.from([42]), private: Buffer.from([1]) }, '101': null } })
    const some = await second.state.keys.get('pre-key', ['100', '101', '911'])
    expect(Buffer.from(some['100']!.public)).toEqual(Buffer.from([42]))
    expect(some['101']).toBeUndefined()
    expect(Buffer.from(some['911']!.public)).toEqual(Buffer.from([811 % 256]))

    await second.clear()
    const third = await usePostgresAuthState(handle.db)
    expect(third.state.creds.registered).toBe(false)
    expect(JSON.stringify(third.state.creds, BufferJSON.replacer)).not.toEqual(JSON.stringify(first.state.creds, BufferJSON.replacer))
    await handle.close()
  })
})
